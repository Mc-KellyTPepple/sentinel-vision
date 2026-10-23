"""API behaviour that does not need the YOLO model (so these run fast, without torch)."""
import pytest
from fastapi.testclient import TestClient

from app import inference, main
from app.config import settings
from app.main import app, require_supabase_user

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_state():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()
    if inference.model_lock.locked():
        inference.model_lock.release()


def signed_in():
    app.dependency_overrides[require_supabase_user] = lambda: {"id": "user-1"}


def upload(name="clip.mp4", data=b"x" * 100):
    return client.post("/api/v1/analyze", files={"file": (name, data, "video/mp4")})


class FakeResponse:
    def __init__(self, status=200, payload=None):
        self.status_code, self._payload = status, payload if payload is not None else {"id": "user-1"}

    def json(self):
        return self._payload


def fake_supabase(monkeypatch, response):
    seen = {}

    class FakeClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            seen["url"], seen["headers"] = url, headers
            return response

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co/")
    monkeypatch.setattr(settings, "supabase_publishable_key", "sb_publishable_test")
    return seen


def test_ready_reports_model_not_loaded_until_first_use():
    body = client.get("/ready").json()
    assert body["status"] == "ready" and body["inference_model_loaded"] is False


def test_analyze_requires_authentication(monkeypatch):
    fake_supabase(monkeypatch, FakeResponse())
    assert upload().status_code == 401
    assert client.post("/api/v1/analyze", headers={"Authorization": "Bearer "},
                       files={"file": ("a.mp4", b"x", "video/mp4")}).status_code == 401


def test_auth_not_configured_returns_503(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_publishable_key", "")
    assert upload().status_code == 503


def test_token_is_verified_with_supabase_and_rejected_when_invalid(monkeypatch):
    seen = fake_supabase(monkeypatch, FakeResponse(401, {"msg": "bad"}))
    r = client.post("/api/v1/analyze", headers={"Authorization": "Bearer abc"},
                    files={"file": ("a.mp4", b"x", "video/mp4")})
    assert r.status_code == 401
    assert seen["url"] == "https://example.supabase.co/auth/v1/user"
    assert seen["headers"]["Authorization"] == "Bearer abc"


def test_upload_validation():
    signed_in()
    assert upload("notes.txt").status_code == 415
    assert upload("clip.mp4", b"").status_code == 400
    settings_max = settings.max_upload_mb
    try:
        settings.max_upload_mb = 1
        assert upload("clip.mp4", b"x" * (1024 * 1024 + 1)).status_code == 413
    finally:
        settings.max_upload_mb = settings_max


def test_second_analysis_is_rejected_while_detector_is_busy():
    signed_in()
    assert inference.model_lock.acquire(blocking=False)
    r = upload()
    assert r.status_code == 429 and "already running" in r.json()["detail"]


def test_live_frame_guards():
    signed_in()
    frame = {"file": ("f.jpg", b"not an image", "image/jpeg")}
    assert client.post("/api/v1/live/frame", files=frame, data={"session_id": "s" * 161}).status_code == 400
    assert client.post("/api/v1/live/frame", files=frame, data={"session_id": "abc"}).status_code == 422
    big = {"file": ("f.jpg", b"x" * (2 * 1024 * 1024 + 1), "image/jpeg")}
    assert client.post("/api/v1/live/frame", files=big, data={"session_id": "abc"}).status_code == 413


def test_detector_settings_are_clamped_and_shared(monkeypatch):
    monkeypatch.setattr(settings, "confidence_threshold", 5.0)
    monkeypatch.setattr(settings, "iou_threshold", 0.0)
    monkeypatch.setattr(settings, "inference_image_size", 99999)
    kw = inference.inference_kwargs()
    assert kw["conf"] == 0.99 and kw["iou"] == 0.1 and kw["imgsz"] == 1280
    assert kw["device"] == "cpu" and kw["persist"] is True


def test_reset_trackers_handles_missing_predictor():
    calls = []

    class Tracker:
        def reset(self): calls.append(1)

    class Predictor:
        trackers = [Tracker(), Tracker()]

    class Model:
        predictor = Predictor()

    inference.reset_trackers(Model())
    inference.reset_trackers(object())  # no predictor yet: must not raise
    assert len(calls) == 2


def test_cors_allows_configured_origin_and_rejects_others():
    allowed = settings.cors_origins[0]
    ok = client.options("/api/v1/analyze", headers={
        "Origin": allowed, "Access-Control-Request-Method": "POST"})
    bad = client.options("/api/v1/analyze", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert ok.headers.get("access-control-allow-origin") == allowed
    assert "access-control-allow-origin" not in bad.headers

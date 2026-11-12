"""Colour attributes, evidence keyframes and the AI analyst endpoint (no YOLO model needed)."""
import asyncio

import cv2
import numpy as np
import pytest

from app import assistant, attributes
from app.config import settings


def solid(bgr, size=(120, 80)):
    image = np.zeros((size[0], size[1], 3), dtype=np.uint8)
    image[:] = bgr
    return image


@pytest.mark.parametrize("bgr,name", [
    ((0, 0, 220), "red"), ((0, 200, 0), "green"), ((220, 60, 0), "blue"), ((0, 220, 230), "yellow"),
    ((10, 10, 10), "black"), ((240, 240, 240), "white"), ((128, 128, 128), "gray"), ((20, 60, 110), "brown"),
])
def test_dominant_color_names_solid_colours(bgr, name):
    frame = solid(bgr)
    assert attributes.dominant_color(frame, (0, 0, 80, 120), "chair") == name


def test_person_colour_comes_from_the_torso_not_the_legs():
    frame = solid((240, 240, 240), (200, 100))
    frame[40:110, :] = (0, 0, 220)   # red shirt
    frame[110:, :] = (120, 40, 0)    # blue trousers
    assert attributes.dominant_color(frame, (0, 0, 100, 200), "person") == "red"


def test_tiny_or_mixed_boxes_have_no_colour():
    frame = solid((0, 0, 220))
    assert attributes.dominant_color(frame, (10, 10, 12, 12), "cup") is None
    stripes = np.zeros((120, 120, 3), dtype=np.uint8)
    colours = [(0, 0, 220), (0, 200, 0), (220, 60, 0), (0, 220, 230)]
    for y in range(0, 120, 15):
        for x in range(0, 120, 15):
            stripes[y:y + 15, x:x + 15] = colours[(x // 15 + 2 * (y // 15)) % 4]
    assert attributes.dominant_color(stripes, (0, 0, 120, 120), "chair") is None


def test_keyframes_are_spaced_and_only_taken_when_the_scene_changes():
    picker = attributes.KeyframePicker(duration=20, max_frames=3)
    image = solid((50, 50, 50))
    taken = []
    for i in range(0, 200):
        t = i * 0.1
        labels = ["person"] if t < 5 else ["person", "cat"] if t < 12 else ["cat"]
        if picker.wants(t, labels):
            picker.add(t, i, labels, image)
            taken.append(round(t, 1))
    assert taken == [0.0, 5.0, 12.0]
    assert picker.items[1]["labels"] == {"cat": 1, "person": 1}
    assert picker.items[0]["image"].startswith("data:image/jpeg;base64,")


def test_encoded_keyframes_are_downscaled():
    data = attributes.encode_jpeg(solid((0, 0, 200), (720, 1280)), max_width=320)
    raw = np.frombuffer(__import__("base64").b64decode(data.split(",", 1)[1]), dtype=np.uint8)
    assert cv2.imdecode(raw, cv2.IMREAD_COLOR).shape[1] == 320


def test_prompt_keeps_event_data_separate_from_the_question():
    messages = assistant.build_messages("How many people?", "Tracks: person #1", "answer")
    assert messages[0]["role"] == "system" and "not proof" in messages[0]["content"]
    assert "<event_data>" in messages[1]["content"] and messages[1]["content"].endswith("Question: How many people?")
    summary = assistant.build_messages("", "x", "summary")[1]["content"]
    assert "summary" in summary.lower()


def test_rate_limit_allows_a_burst_then_refuses(monkeypatch):
    monkeypatch.setattr(assistant, "_recent", assistant.defaultdict(assistant.deque))
    for i in range(3):
        assistant.check_rate_limit("u1", 3, now=100 + i)
    with pytest.raises(Exception) as err:
        assistant.check_rate_limit("u1", 3, now=104)
    assert getattr(err.value, "status_code", None) == 429
    assistant.check_rate_limit("u2", 3, now=104)  # other users are not affected
    assistant.check_rate_limit("u1", 3, now=170)  # a minute later it works again


def test_ask_without_a_key_explains_the_fallback(monkeypatch):
    monkeypatch.setattr(settings, "groq_api_key", "")
    monkeypatch.setattr(settings, "llm_api_key", "")
    with pytest.raises(Exception) as err:
        asyncio.run(assistant.ask_llm("q", "ctx", "answer"))
    assert err.value.status_code == 503 and "built-in analyst" in err.value.detail


def test_ask_calls_an_openai_compatible_api(monkeypatch):
    seen = {}

    class Response:
        status_code = 200
        def json(self):
            return {"choices": [{"message": {"content": " Two people. "}}]}

    class Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None):
            seen.update(url=url, headers=headers, json=json)
            return Response()

    monkeypatch.setattr(assistant.httpx, "AsyncClient", Client)
    monkeypatch.setattr(settings, "groq_api_key", "gsk_test")
    monkeypatch.setattr(settings, "llm_api_key", "")
    out = asyncio.run(assistant.ask_llm("How many people?", "person #1, person #2", "answer"))
    assert out == {"answer": "Two people.", "model": settings.llm_model, "source": "llm"}
    assert seen["url"].endswith("/chat/completions") and seen["headers"]["Authorization"] == "Bearer gsk_test"
    assert seen["json"]["messages"][1]["content"].count("person #2") == 1

import logging
import os
import base64
import tempfile
import threading
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np
from fastapi import HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from .attributes import KeyframePicker, dominant_color
from .config import settings
from .schemas import AnalysisSummary, Detection

API_VERSION = "0.2.0"

if TYPE_CHECKING:  # ultralytics/torch are imported lazily, on the first inference request
    from ultralytics import YOLO

_model: "YOLO | None" = None
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

# One YOLO model and one ByteTrack state are shared by the whole process, so every use of the
# model (uploaded clips AND live frames) must hold this lock. Inference runs in worker threads
# so the event loop stays responsive (/health keeps answering during a long analysis).
model_lock = threading.Lock()
# Which live-camera session the tracker state currently belongs to (None = needs a reset).
live_state: dict[str, str | None] = {"session_id": None}
LOCK_WAIT_SECONDS = 20

# Start-up warm-up state: idle -> loading -> ready (or failed). Free hosts take about a minute to import
# PyTorch and load the model; during that time requests get a quick, readable 503 instead of hanging.
warmup: dict[str, str | None] = {"state": "idle", "error": None}
_log = logging.getLogger("uvicorn.error")

def raise_if_loading() -> None:
    if warmup["state"] == "loading":
        raise HTTPException(
            status_code=503,
            detail="The detector is starting up (it takes about a minute after the server wakes). Retrying automatically.",
            headers={"Retry-After": "5"},
        )

def warm_up() -> None:
    """Load the detector and run one blank frame so the first real request is fast. Safe to call twice."""
    if warmup["state"] in ("loading", "ready"):
        return
    warmup["state"], warmup["error"] = "loading", None
    try:
        with model_lock:
            model = get_model()
            model.track(source=np.zeros((416, 416, 3), dtype=np.uint8), **inference_kwargs())
            reset_trackers(model)
            live_state["session_id"] = None
        warmup["state"] = "ready"
        _log.info("Detector warm-up finished.")
    except Exception as exc:  # the lazy path in exclusive_model still works if warm-up failed
        warmup["state"], warmup["error"] = "failed", f"{type(exc).__name__}: {exc}"[:200]
        _log.exception("Detector warm-up failed; falling back to loading on the first request.")

def get_model() -> "YOLO":
    global _model
    if _model is None:
        from ultralytics import YOLO  # heavy import (torch); deferred so startup and /health stay fast
        try:  # do not rely on OMP_NUM_THREADS being set on the host (14 Nov 2026: an analysis ran for many minutes)
            import torch
            torch.set_num_threads(max(1, settings.torch_num_threads))
        except Exception:  # pragma: no cover - torch always ships with ultralytics
            pass
        _model = YOLO(settings.model_name)
    return _model

def is_model_loaded() -> bool:
    return _model is not None

def inference_kwargs() -> dict:
    """Detector settings shared by the upload and live paths (clamped to safe ranges)."""
    return {
        "conf": max(0.01, min(0.99, settings.confidence_threshold)),
        "iou": max(0.1, min(0.9, settings.iou_threshold)),
        "imgsz": max(320, min(1280, settings.inference_image_size)),
        "device": "cpu", "tracker": "bytetrack.yaml", "persist": True, "verbose": False,
    }

def run_config(fps: float | None = None) -> dict:
    """Everything needed to reproduce an analysis: model, thresholds, sampling and versions."""
    try:
        from importlib.metadata import version
        ultralytics_version = version("ultralytics")
    except Exception:  # not installed in tests
        ultralytics_version = None
    kw = inference_kwargs()
    return {
        "api_version": API_VERSION, "model": settings.model_name, "ultralytics": ultralytics_version,
        "tracker": kw["tracker"], "device": kw["device"], "confidence_threshold": kw["conf"],
        "iou_threshold": kw["iou"], "image_size": kw["imgsz"], "frame_stride": max(1, settings.frame_stride),
        "max_analysis_frames": settings.max_analysis_frames,
        "sampled_fps": round(fps / max(1, settings.frame_stride), 3) if fps else None,
    }

def reset_trackers(model) -> None:
    predictor = getattr(model, "predictor", None)
    trackers = getattr(predictor, "trackers", None) if predictor is not None else None
    for tracker in trackers or []:
        reset = getattr(tracker, "reset", None)
        if callable(reset):
            reset()

@contextmanager
def exclusive_model(wait_seconds: float = LOCK_WAIT_SECONDS):
    raise_if_loading()
    if not model_lock.acquire(timeout=wait_seconds):
        raise HTTPException(status_code=503, detail="The detector is busy with another request. Please retry in a moment.")
    try:
        yield get_model()
    finally:
        model_lock.release()

async def read_limited_upload(upload: UploadFile) -> bytes:
    extension = Path(upload.filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported video extension")
    max_bytes = settings.max_upload_mb * 1024 * 1024
    chunks, total = [], 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=f"Video exceeds {settings.max_upload_mb} MB limit")
        chunks.append(chunk)
    content = b"".join(chunks)
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded video is empty")
    return content

async def analyze_upload(upload: UploadFile) -> AnalysisSummary:
    """Read the upload (async), then run the CPU-heavy analysis in a worker thread."""
    raise_if_loading()
    try:
        content = await read_limited_upload(upload)
        filename = upload.filename or "video.mp4"
    finally:
        await upload.close()
    # Reject immediately instead of queueing large uploads behind a running analysis.
    if model_lock.locked():
        raise HTTPException(status_code=429, detail="Another analysis is already running. Please retry in a moment.")
    return await run_in_threadpool(analyze_bytes, content, filename)

def analyze_bytes(content: bytes, filename: str) -> AnalysisSummary:
    suffix = Path(filename).suffix.lower() or ".mp4"
    temp_path = None
    started = time.perf_counter()
    cap = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            temp_path = tmp.name
        cap = cv2.VideoCapture(temp_path)
        if not cap.isOpened():
            raise HTTPException(status_code=422, detail="Could not decode this video file")
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = frame_count / fps if fps > 0 and frame_count > 0 else 0.0
        if duration <= 0:
            raise HTTPException(status_code=422, detail="Video duration could not be determined")
        if duration > settings.max_video_seconds:
            raise HTTPException(status_code=413, detail=f"Video exceeds {settings.max_video_seconds} second limit")

        with exclusive_model() as model:
            return _analyze_with_model(model, cap, filename, fps, duration, started)
    finally:
        if cap is not None:
            cap.release()
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)

def _analyze_with_model(model, cap, filename: str, fps: float, duration: float, started: float) -> AnalysisSummary:
    # Track IDs are scoped to this uploaded video: reset tracker state left by earlier requests,
    # and mark the live tracker as stale so the next live frame starts from a clean state.
    reset_trackers(model)
    live_state["session_id"] = None
    try:
        detections, counts = [], Counter()
        confidence_by_class: dict[str, list[float]] = {}
        frames_by_class: dict[str, set[int]] = {}
        tracks_by_class: dict[str, set[int]] = {}
        preview_image = None
        keyframes = KeyframePicker(duration, max(0, settings.max_keyframes))
        frame_index = sampled = processed = 0
        stopped_at: float | None = None  # clip time where the time budget ran out
        inference_started = time.perf_counter()
        while sampled < settings.max_analysis_frames:
            if processed and time.perf_counter() - inference_started > settings.max_analysis_seconds:
                stopped_at = frame_index / fps
                break
            ok, frame = cap.read()
            if not ok:
                break
            current = frame_index
            frame_index += 1
            if current % max(1, settings.frame_stride):
                continue
            sampled += 1
            result = model.track(source=frame, **inference_kwargs())[0]
            processed += 1
            t_now = current / fps
            frame_labels = [str(result.names.get(int(b.cls.item()), int(b.cls.item()))) for b in result.boxes] if result.boxes is not None else []
            annotated = None
            # Save an annotated JPEG from the first processed frame for the dashboard preview.
            if preview_image is None:
                annotated = result.plot()
                ok_jpg, encoded = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
                if ok_jpg:
                    preview_image = "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")
            # Evidence keyframes: only frames where what is visible changes (drawn and encoded only when chosen).
            if keyframes.wants(t_now, frame_labels):
                keyframes.add(t_now, current, frame_labels, annotated if annotated is not None else result.plot())
            if result.boxes is None:
                continue
            detections_before_frame = len(detections)
            for box in result.boxes:
                cls_id = int(box.cls.item())
                label = str(result.names.get(cls_id, cls_id))
                confidence = float(box.conf.item())
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                # Track IDs align with the current frame's boxes.
                track_id = None
                try:
                    box_index = len(detections) - detections_before_frame
                    if getattr(result.boxes, "id", None) is not None:
                        track_id = int(result.boxes.id[box_index].item())
                except (AttributeError, IndexError, TypeError, ValueError):
                    track_id = None
                detections.append(Detection(
                    frame=current, timestamp_seconds=round(current / fps, 3),
                    class_id=cls_id, label=label, confidence=round(confidence, 5),
                    x1=round(x1, 2), y1=round(y1, 2), x2=round(x2, 2), y2=round(y2, 2),
                    track_id=track_id, color=dominant_color(frame, (x1, y1, x2, y2), label),
                ))
                counts[label] += 1
                confidence_by_class.setdefault(label, []).append(confidence)
                frames_by_class.setdefault(label, set()).add(current)
                if track_id is not None:
                    tracks_by_class.setdefault(label, set()).add(track_id)
        inference_elapsed = max(time.perf_counter() - inference_started, 1e-9)
        elapsed = time.perf_counter() - started
        class_metrics: dict[str, dict[str, float | int]] = {}
        denominator = max(processed, 1)
        for label, values in confidence_by_class.items():
            class_metrics[label] = {
                "average_confidence": round(sum(values) / len(values), 4),
                "min_confidence": round(min(values), 4),
                "max_confidence": round(max(values), 4),
                "detections": len(values),
                "frames_present": len(frames_by_class.get(label, set())),
                "frame_coverage_percent": round(100 * len(frames_by_class.get(label, set())) / denominator, 2),
                "unique_track_ids": len(tracks_by_class.get(label, set())),
            }
        return AnalysisSummary(
            filename=filename, duration_seconds=round(duration, 3),
            source_fps=round(fps, 3), frames_sampled=sampled, frames_processed=processed,
            processing_seconds=round(elapsed, 3),
            average_inference_fps=round(processed / inference_elapsed, 3),
            detections_count=len(detections), class_counts=dict(counts), class_metrics=class_metrics,
            frame_width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0) or None,
            frame_height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0) or None,
            detections=detections, preview_image=preview_image,
            keyframes=keyframes.items, run_config=run_config(fps),
            note=(
                "CPU-based sampled-frame detection with ByteTrack IDs. Class diagnostics include "
                "confidence and frame coverage; high coverage is not proof of a real-world event. "
                "Track IDs may change when objects are occluded or missed."
                + (f" The server was slow, so analysis stopped after {settings.max_analysis_seconds}s: only the first "
                   f"{stopped_at:.1f}s of the clip were analysed." if stopped_at is not None else "")
            )
        )
    finally:
        live_state["session_id"] = None  # clip tracks must never leak into a live session


MAX_LIVE_DIMENSION = 960

def process_live_frame(content: bytes, session_id: str) -> dict:
    """Decode one webcam JPEG, track objects, and return detections plus an annotated preview.
    Runs in a worker thread; uses the same detector settings as uploaded-clip analysis."""
    raise_if_loading()
    frame = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=422, detail="Could not decode the webcam frame.")
    height, width = frame.shape[:2]
    if width > MAX_LIVE_DIMENSION or height > MAX_LIVE_DIMENSION:
        scale = min(MAX_LIVE_DIMENSION / width, MAX_LIVE_DIMENSION / height)
        frame = cv2.resize(frame, (int(width * scale), int(height * scale)))
        height, width = frame.shape[:2]
    started = time.perf_counter()
    with exclusive_model() as model:
        if live_state["session_id"] != session_id:  # new browser session -> fresh track IDs
            reset_trackers(model)
            live_state["session_id"] = session_id
        result = model.track(source=frame, **inference_kwargs())[0]
        detections = []
        boxes = result.boxes
        if boxes is not None:
            for index, box in enumerate(boxes):
                track_id = None
                try:
                    if getattr(boxes, "id", None) is not None:
                        track_id = int(boxes.id[index].item())
                except (AttributeError, IndexError, TypeError, ValueError):
                    track_id = None
                cls_id = int(box.cls.item())
                x1, y1, x2, y2 = [round(float(v), 2) for v in box.xyxy[0].tolist()]
                label = str(result.names.get(cls_id, cls_id))
                detections.append({
                    "track_id": track_id, "label": label, "color": dominant_color(frame, (x1, y1, x2, y2), label),
                    "confidence": round(float(box.conf.item()), 5),
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                })
        annotated = result.plot()
    ok_jpg, jpeg = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    annotated_image = "data:image/jpeg;base64," + base64.b64encode(jpeg.tobytes()).decode("ascii") if ok_jpg else None
    return {
        "session_id": session_id, "processed_ms": round((time.perf_counter() - started) * 1000, 1),
        "detections": detections, "annotated_image": annotated_image,
        "frame_width": width, "frame_height": height,
    }

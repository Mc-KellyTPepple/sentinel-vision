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

from .config import settings
from .schemas import AnalysisSummary, Detection

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

def get_model() -> "YOLO":
    global _model
    if _model is None:
        from ultralytics import YOLO  # heavy import (torch); deferred so startup and /health stay fast
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

def reset_trackers(model) -> None:
    predictor = getattr(model, "predictor", None)
    trackers = getattr(predictor, "trackers", None) if predictor is not None else None
    for tracker in trackers or []:
        reset = getattr(tracker, "reset", None)
        if callable(reset):
            reset()

@contextmanager
def exclusive_model(wait_seconds: float = LOCK_WAIT_SECONDS):
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
        frame_index = sampled = processed = 0
        inference_started = time.perf_counter()
        while sampled < settings.max_analysis_frames:
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
            # Save an annotated JPEG from the first processed frame for the dashboard preview.
            if preview_image is None:
                annotated = result.plot()
                ok_jpg, encoded = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
                if ok_jpg:
                    preview_image = "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")
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
                    track_id=track_id,
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
            detections=detections, preview_image=preview_image,
            note=(
                "CPU-based sampled-frame detection with ByteTrack IDs. Class diagnostics include "
                "confidence and frame coverage; high coverage is not proof of a real-world event. "
                "Track IDs may change when objects are occluded or missed."
            )
        )
    finally:
        live_state["session_id"] = None  # clip tracks must never leak into a live session


MAX_LIVE_DIMENSION = 960

def process_live_frame(content: bytes, session_id: str) -> dict:
    """Decode one webcam JPEG, track objects, and return detections plus an annotated preview.
    Runs in a worker thread; uses the same detector settings as uploaded-clip analysis."""
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
                detections.append({
                    "track_id": track_id, "label": str(result.names.get(cls_id, cls_id)),
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

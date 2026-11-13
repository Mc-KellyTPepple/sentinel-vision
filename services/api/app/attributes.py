"""Cheap per-object attributes and evidence keyframes (numpy + OpenCV only, a few milliseconds per frame on CPU).

Colours are the dominant colour of the object's box (for a person, the torso area), so "person wearing red" questions
can be answered. They are approximate: lighting, shadows and the background inside the box all affect them.
"""
from __future__ import annotations

import base64

import cv2
import numpy as np

COLOR_NAMES = ("black", "white", "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown")


def _region(frame: np.ndarray, box: tuple[float, float, float, float], label: str) -> np.ndarray | None:
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    if w < 4 or h < 4:
        return None
    if label == "person":  # torso: below the head, above the legs, away from the arms and background at the sides
        rx1, rx2, ry1, ry2 = x1 + 0.25 * w, x2 - 0.25 * w, y1 + 0.18 * h, y1 + 0.55 * h
    else:  # centre half of the box
        rx1, rx2, ry1, ry2 = x1 + 0.25 * w, x2 - 0.25 * w, y1 + 0.25 * h, y2 - 0.25 * h
    ix1, iy1 = max(0, int(rx1)), max(0, int(ry1))
    ix2, iy2 = min(width, int(rx2)), min(height, int(ry2))
    if ix2 - ix1 < 2 or iy2 - iy1 < 2:
        return None
    return frame[iy1:iy2, ix1:ix2]


def classify_pixels(hsv: np.ndarray) -> np.ndarray:
    """Name index (into COLOR_NAMES) for every pixel of an OpenCV HSV image (H 0-179, S and V 0-255)."""
    h = hsv[..., 0].astype(np.int16)
    s = hsv[..., 1].astype(np.int16)
    v = hsv[..., 2].astype(np.int16)
    out = np.full(h.shape, COLOR_NAMES.index("gray"), dtype=np.int8)
    chromatic = (s >= 60) & (v >= 50)
    hue_name = np.select(
        [h < 8, h < 20, h < 33, h < 85, h < 130, h < 148, h < 168],
        [3, 4, 5, 6, 7, 8, 9],
        default=3,  # 168-179 wraps back to red
    ).astype(np.int8)
    out = np.where(chromatic, hue_name, out)
    # dark orange / red-orange reads as brown
    out = np.where(chromatic & (out == 4) & (v < 150), COLOR_NAMES.index("brown"), out)
    out = np.where(~chromatic & (v >= 185) & (s < 40), COLOR_NAMES.index("white"), out)
    out = np.where(v < 50, COLOR_NAMES.index("black"), out)
    return out


def dominant_color(frame: np.ndarray, box: tuple[float, float, float, float], label: str) -> str | None:
    """Most common colour name in the box region, or None when no colour covers at least 30% of it."""
    region = _region(frame, box, label)
    if region is None:
        return None
    small = cv2.resize(region, (16, 16), interpolation=cv2.INTER_AREA)
    names = classify_pixels(cv2.cvtColor(small, cv2.COLOR_BGR2HSV)).ravel()
    counts = np.bincount(names.astype(np.int64), minlength=len(COLOR_NAMES))
    best = int(counts.argmax())
    return COLOR_NAMES[best] if counts[best] >= 0.3 * names.size else None


def encode_jpeg(image: np.ndarray, max_width: int = 480, quality: int = 60) -> str | None:
    """Downscale and encode as a data URL (keeps keyframes around 15-35 KB each)."""
    height, width = image.shape[:2]
    if width > max_width:
        image = cv2.resize(image, (max_width, int(height * max_width / width)), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii") if ok else None


class KeyframePicker:
    """Keeps a few annotated frames as evidence: the first frame, then frames where what is visible changes,
    spaced out over the clip. Only the chosen frames are drawn and encoded, so the cost stays small."""

    def __init__(self, duration: float, max_frames: int = 8):
        self.max_frames = max_frames
        self.min_gap = max(1.0, duration / (max_frames + 2))
        self.items: list[dict] = []
        self._last_signature: tuple | None = None
        self._last_t = -1e9

    def wants(self, t: float, labels: list[str]) -> bool:
        if len(self.items) >= self.max_frames:
            return False
        signature = tuple(sorted((label, labels.count(label)) for label in set(labels)))
        if self.items and (signature == self._last_signature or t - self._last_t < self.min_gap):
            return False
        self._last_signature, self._last_t = signature, t
        return True

    def add(self, t: float, frame_index: int, labels: list[str], annotated: np.ndarray) -> None:
        image = encode_jpeg(annotated)
        if image:
            counts = {label: labels.count(label) for label in sorted(set(labels))}
            self.items.append({"t": round(t, 3), "frame": frame_index, "labels": counts, "image": image})

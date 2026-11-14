"""YOLO11n object detection with ONNX Runtime (no PyTorch), plus a small ByteTrack-style tracker.

Free hosting gives the container a fraction of one CPU. PyTorch + Ultralytics needed about 23 s per frame
there; ONNX Runtime on one thread runs the same network in a fraction of that, starts in seconds and uses far
less memory. Pre- and post-processing follow Ultralytics' own (letterbox to a multiple of 32, grey 114 padding,
RGB/255 input, per-class NMS), so detections match what `YOLO.predict` gives on the same weights.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field

import cv2
import numpy as np

COCO_NAMES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
    "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors",
    "teddy bear", "hair drier", "toothbrush",
]

# Ultralytics' default box palette (hex RGB), so annotated frames look the same as before.
_PALETTE_HEX = ["042AFF", "0BDBEB", "F3F3F3", "00DFB7", "111F68", "FF6FDD", "FF444F", "CCED00", "00F344", "BD00FF",
                "00B4FF", "DD00BA", "00FFFF", "26C000", "01FFB3", "7D24FF", "7B0068", "FF1B6C", "FC6D2F", "A2FF0B"]
PALETTE_BGR = [(int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16)) for h in _PALETTE_HEX]

MAX_DETECTIONS = 300
LOW_CONFIDENCE = 0.1  # ByteTrack's second stage: weak boxes may only extend existing tracks


@dataclass
class Box:
    cls_id: int
    label: str
    confidence: float
    xyxy: tuple[float, float, float, float]
    track_id: int | None = None


@dataclass
class FrameResult:
    image: np.ndarray
    boxes: list[Box] = field(default_factory=list)

    @property
    def labels(self) -> list[str]:
        return [b.label for b in self.boxes]

    def plot(self) -> np.ndarray:
        return draw_boxes(self.image, self.boxes)


def letterbox(image: np.ndarray, size: int, stride: int = 32) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Resize keeping aspect ratio so the long side is `size`, then pad to a multiple of `stride` (minimal padding,
    as Ultralytics does for dynamic-shape models). Returns the padded image, the scale and the (left, top) padding."""
    height, width = image.shape[:2]
    scale = min(size / height, size / width)
    new_w, new_h = int(round(width * scale)), int(round(height * scale))
    target_w, target_h = int(np.ceil(new_w / stride) * stride), int(np.ceil(new_h / stride) * stride)
    pad_x, pad_y = (target_w - new_w) / 2, (target_h - new_h) / 2
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR) if (new_w, new_h) != (width, height) else image
    top, bottom = int(round(pad_y - 0.1)), int(round(pad_y + 0.1))
    left, right = int(round(pad_x - 0.1)), int(round(pad_x + 0.1))
    padded = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114))
    return padded, scale, (left, top)


def decode(output: np.ndarray, conf: float, iou: float, scale: float, pad: tuple[float, float],
           width: int, height: int) -> list[tuple[int, float, tuple[float, float, float, float]]]:
    """YOLO11 head output (1, 4+classes, anchors) -> [(class, confidence, xyxy in original pixels)] after NMS."""
    pred = output[0].T  # anchors x (4 + classes)
    scores = pred[:, 4:]
    cls_ids = scores.argmax(axis=1)
    confs = scores[np.arange(len(scores)), cls_ids]
    keep = confs >= conf
    if not keep.any():
        return []
    pred, cls_ids, confs = pred[keep], cls_ids[keep], confs[keep]
    cx, cy, w, h = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
    x1 = (cx - w / 2 - pad[0]) / scale
    y1 = (cy - h / 2 - pad[1]) / scale
    x2 = (cx + w / 2 - pad[0]) / scale
    y2 = (cy + h / 2 - pad[1]) / scale
    x1, x2 = np.clip(x1, 0, width), np.clip(x2, 0, width)
    y1, y2 = np.clip(y1, 0, height), np.clip(y2, 0, height)
    rects = np.stack([x1, y1, x2 - x1, y2 - y1], axis=1)
    indices = cv2.dnn.NMSBoxesBatched(rects.tolist(), confs.astype(float).tolist(), cls_ids.astype(int).tolist(),
                                      conf, iou)
    indices = np.array(indices).reshape(-1)
    order = indices[np.argsort(-confs[indices])][:MAX_DETECTIONS] if len(indices) else []
    return [(int(cls_ids[i]), float(confs[i]), (float(x1[i]), float(y1[i]), float(x2[i]), float(y2[i]))) for i in order]


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), dtype=np.float32)
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(area_a[:, None] + area_b[None, :] - inter, 1e-9)


@dataclass
class _Track:
    track_id: int
    cls_id: int
    box: np.ndarray       # last xyxy
    velocity: np.ndarray  # per-update change of xyxy (smoothed)
    missed: int = 0

    def predicted(self) -> np.ndarray:
        return self.box + self.velocity * (self.missed + 1)


class Tracker:
    """ByteTrack-lite: match confident boxes to predicted track positions by IoU (greedy, same class), then let weak
    boxes extend unmatched tracks, start new tracks from unmatched confident boxes, and drop tracks unseen for
    `max_missed` frames. IDs start at 1 and are never reused until `reset()`."""

    def __init__(self, match_iou: float = 0.3, max_missed: int = 30, max_jump: float = 1.5):
        self.match_iou, self.max_missed, self.max_jump = match_iou, max_missed, max_jump
        self.reset()

    def reset(self) -> None:
        self.tracks: list[_Track] = []
        self._next_id = 1

    def _match(self, tracks: list[_Track], boxes: np.ndarray, classes: np.ndarray) -> list[tuple[int, int]]:
        if not tracks or len(boxes) == 0:
            return []
        predicted = np.array([t.predicted() for t in tracks])
        scores = iou_matrix(predicted, boxes)
        # Fast movement between sampled frames can leave no overlap at all, so a box whose centre lies within
        # one track-size of the predicted centre also matches, ranked below every real IoU match.
        size = np.maximum(predicted[:, 2] - predicted[:, 0], predicted[:, 3] - predicted[:, 1])[:, None]
        centre_t = (predicted[:, None, :2] + predicted[:, None, 2:]) / 2
        centre_d = (boxes[None, :, :2] + boxes[None, :, 2:]) / 2
        distance = np.linalg.norm(centre_t - centre_d, axis=2) / np.maximum(size, 1.0)
        near = np.where(distance < self.max_jump, (self.match_iou - 0.01) * (1 - distance / self.max_jump / 2), 0.0)
        scores = np.where(scores >= self.match_iou, scores, np.maximum(scores, near))
        same_class = np.array([[t.cls_id == c for c in classes] for t in tracks])
        scores = np.where(same_class, scores, 0.0)
        pairs, used_t, used_d = [], set(), set()
        for flat in np.argsort(-scores, axis=None):
            ti, di = np.unravel_index(flat, scores.shape)
            if scores[ti, di] <= 0.05:
                break
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti); used_d.add(di); pairs.append((int(ti), int(di)))
        return pairs

    def _update_track(self, track: _Track, box: np.ndarray) -> None:
        step = (box - track.box) / (track.missed + 1)
        track.velocity = 0.6 * track.velocity + 0.4 * step
        track.box, track.missed = box, 0

    def update(self, detections: list[tuple[int, float, tuple]], conf: float) -> list[int | None]:
        """Assigns a track ID to every detection with confidence >= conf (None for the weak ones)."""
        ids: list[int | None] = [None] * len(detections)
        strong = [i for i, d in enumerate(detections) if d[1] >= conf]
        weak = [i for i, d in enumerate(detections) if d[1] < conf]
        box_of = lambda idx: np.array([detections[i][2] for i in idx], dtype=np.float32).reshape(-1, 4)
        cls_of = lambda idx: np.array([detections[i][0] for i in idx])

        unmatched = list(self.tracks)
        pairs = self._match(unmatched, box_of(strong), cls_of(strong))
        matched_t = set()
        for ti, di in pairs:
            track = unmatched[ti]
            self._update_track(track, box_of([strong[di]])[0])
            ids[strong[di]] = track.track_id
            matched_t.add(ti)
        matched_strong = {strong[di] for _, di in pairs}
        remaining = [t for i, t in enumerate(unmatched) if i not in matched_t]

        # Second stage: weak boxes keep an existing track alive (not reported, but the track is not lost).
        refreshed = set()
        for ti, di in self._match(remaining, box_of(weak), cls_of(weak)):
            self._update_track(remaining[ti], box_of([weak[di]])[0])
            refreshed.add(ti)
        for i, track in enumerate(remaining):
            if i not in refreshed:
                track.missed += 1
        self.tracks = [t for t in self.tracks if t.missed <= self.max_missed]

        # New tracks from confident boxes nobody claimed.
        for i in strong:
            if i in matched_strong:
                continue
            track = _Track(self._next_id, detections[i][0], np.array(detections[i][2], dtype=np.float32),
                           np.zeros(4, dtype=np.float32))
            self._next_id += 1
            self.tracks.append(track)
            ids[i] = track.track_id
        return ids


def draw_boxes(image: np.ndarray, boxes: list[Box]) -> np.ndarray:
    """Boxes with "id:N label 0.87" tags in the Ultralytics palette (a copy; the input frame is not changed)."""
    out = image.copy()
    height, width = out.shape[:2]
    thickness = max(round((height + width) / 2 * 0.003), 2)
    font_scale = max(thickness / 3, 0.4)
    for box in boxes:
        color = PALETTE_BGR[box.cls_id % len(PALETTE_BGR)]
        x1, y1, x2, y2 = (int(round(v)) for v in box.xyxy)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, thickness, cv2.LINE_AA)
        tag = (f"id:{box.track_id} " if box.track_id is not None else "") + f"{box.label} {box.confidence:.2f}"
        (tw, th), base = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, font_scale, max(thickness - 1, 1))
        outside = y1 - th - base - 3 >= 0
        ty1 = y1 - th - base - 3 if outside else y1
        ty2 = y1 if outside else y1 + th + base + 3
        cv2.rectangle(out, (x1, ty1), (min(x1 + tw + 4, width), ty2), color, -1, cv2.LINE_AA)
        text_color = (0, 0, 0) if sum(color) / 3 > 140 else (255, 255, 255)
        cv2.putText(out, tag, (x1 + 2, ty2 - base - 1), cv2.FONT_HERSHEY_SIMPLEX, font_scale, text_color,
                    max(thickness - 1, 1), cv2.LINE_AA)
    return out


class OnnxDetector:
    """The detector used by the API: `track(frame)` detects, tracks and returns a FrameResult."""

    def __init__(self, path: str, threads: int = 1):
        import onnxruntime as ort  # imported here so the API and its tests start without it

        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, threads)
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.names = self._read_names()
        self.tracker = Tracker()
        self.runtime_version = ort.__version__

    def _read_names(self) -> dict[int, str]:
        try:
            raw = self.session.get_modelmeta().custom_metadata_map.get("names")
            names = ast.literal_eval(raw) if raw else None
            if isinstance(names, dict) and names:
                return {int(k): str(v) for k, v in names.items()}
        except (ValueError, SyntaxError):
            pass
        return dict(enumerate(COCO_NAMES))

    def detect(self, frame: np.ndarray, conf: float, iou: float, imgsz: int):
        height, width = frame.shape[:2]
        padded, scale, pad = letterbox(frame, imgsz)
        blob = np.ascontiguousarray(padded[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
        output = self.session.run(None, {self.input_name: blob})[0]
        return decode(output, min(conf, LOW_CONFIDENCE), iou, scale, pad, width, height)

    def track(self, frame: np.ndarray, conf: float, iou: float, imgsz: int) -> FrameResult:
        raw = self.detect(frame, conf, iou, imgsz)
        ids = self.tracker.update(raw, conf)
        boxes = [Box(c, self.names.get(c, str(c)), s, xyxy, track_id)
                 for (c, s, xyxy), track_id in zip(raw, ids) if s >= conf]
        return FrameResult(frame, boxes)

    def reset(self) -> None:
        self.tracker.reset()

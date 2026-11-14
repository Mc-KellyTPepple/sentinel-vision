"""ONNX detector pieces: letterbox, output decoding/NMS, the tracker and drawing (no model file needed),
plus one end-to-end check on the real yolo11n.onnx when it is present (the Docker build downloads it)."""
from pathlib import Path

import numpy as np
import pytest

from app.detector import Box, FrameResult, Tracker, decode, draw_boxes, iou_matrix, letterbox

MODEL = Path(__file__).resolve().parents[1] / "yolo11n.onnx"


def test_letterbox_keeps_aspect_and_pads_to_stride():
    image = np.zeros((720, 1280, 3), dtype=np.uint8)
    padded, scale, (left, top) = letterbox(image, 416)
    assert padded.shape[:2] == (256, 416)  # 234 rows rounded up to a multiple of 32
    assert scale == pytest.approx(416 / 1280) and left == 0 and top == 11
    assert padded[0, 0].tolist() == [114, 114, 114]


def head_output(rows):
    """Builds a (1, 84, N) YOLO11 head output from (cx, cy, w, h, class, score) rows."""
    out = np.zeros((1, 84, len(rows)), dtype=np.float32)
    for i, (cx, cy, w, h, cls, score) in enumerate(rows):
        out[0, :4, i] = (cx, cy, w, h)
        out[0, 4 + cls, i] = score
    return out


def test_decode_maps_back_to_the_frame_and_runs_per_class_nms():
    out = head_output([
        (100, 100, 40, 80, 0, 0.9),   # person
        (102, 101, 40, 80, 0, 0.6),   # duplicate person -> suppressed
        (101, 100, 40, 80, 41, 0.7),  # cup at the same place -> kept (NMS is per class)
        (300, 200, 20, 20, 0, 0.2),   # below the threshold
    ])
    dets = decode(out, conf=0.35, iou=0.45, scale=0.5, pad=(0, 10), width=1280, height=720)
    assert [(c, round(s, 2)) for c, s, _ in dets] == [(0, 0.9), (41, 0.7)]
    assert dets[0][2] == pytest.approx((160.0, 100.0, 240.0, 260.0))


def test_decode_clips_boxes_and_handles_no_detections():
    assert decode(head_output([(5, 5, 4, 4, 0, 0.1)]), 0.35, 0.45, 1.0, (0, 0), 100, 100) == []
    (c, s, box), = decode(head_output([(2, 2, 10, 10, 0, 0.9)]), 0.35, 0.45, 1.0, (0, 0), 100, 100)
    assert box[0] == 0.0 and box[1] == 0.0


def test_iou_matrix():
    a = np.array([[0, 0, 10, 10]], dtype=np.float32)
    b = np.array([[0, 0, 10, 10], [5, 0, 15, 10], [20, 20, 30, 30]], dtype=np.float32)
    assert iou_matrix(a, b)[0].tolist() == pytest.approx([1.0, 1 / 3, 0.0])


def test_tracker_keeps_ids_through_fast_motion_and_short_gaps():
    tracker = Tracker()
    ids = []
    for step in range(10):
        x = 50 + step * 70  # moves more than its own width between frames: no overlap
        dets = [(0, 0.9, (x, 100, x + 50, 250)), (41, 0.8, (600, 400, 640, 450))]
        if step == 4:
            dets = [dets[1]]  # person missed for one frame
        ids.append(tracker.update(dets, conf=0.35))
    person_ids = {frame[0] for i, frame in enumerate(ids) if i != 4}
    cup_ids = {frame[-1] for frame in ids}
    assert person_ids == {1} and cup_ids == {2}


def test_tracker_separates_classes_and_new_objects_and_resets():
    tracker = Tracker()
    assert tracker.update([(0, 0.9, (0, 0, 50, 100)), (41, 0.9, (0, 0, 50, 100))], 0.35) == [1, 2]
    assert tracker.update([(0, 0.9, (0, 0, 50, 100)), (0, 0.9, (900, 0, 950, 100))], 0.35) == [1, 3]
    tracker.reset()
    assert tracker.update([(0, 0.9, (900, 0, 950, 100))], 0.35) == [1]


def test_weak_boxes_keep_a_track_alive_but_get_no_id():
    tracker = Tracker(max_missed=1)
    tracker.update([(0, 0.9, (0, 0, 50, 100))], 0.35)
    for _ in range(3):  # without the weak box the track would be dropped after one miss
        assert tracker.update([(0, 0.2, (2, 0, 52, 100))], 0.35) == [None]
    assert tracker.update([(0, 0.9, (4, 0, 54, 100))], 0.35) == [1]


def test_draw_boxes_returns_an_annotated_copy():
    frame = np.zeros((240, 320, 3), dtype=np.uint8)
    result = FrameResult(frame, [Box(0, "person", 0.87, (10, 20, 100, 200), 3)])
    drawn = result.plot()
    assert drawn.shape == frame.shape and drawn.any() and not frame.any()
    assert result.labels == ["person"]
    assert draw_boxes(frame, []).sum() == 0


@pytest.mark.skipif(not MODEL.exists(), reason="yolo11n.onnx is downloaded by the Docker build")
def test_real_model_finds_a_person_in_a_photo():
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("onnxruntime")
    from app.detector import OnnxDetector

    data = pytest.importorskip("skimage.data")
    image = cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR)
    detector = OnnxDetector(str(MODEL))
    first = detector.track(image, conf=0.35, iou=0.45, imgsz=416)
    second = detector.track(image, conf=0.35, iou=0.45, imgsz=416)
    people = [b for b in first.boxes if b.label == "person"]
    assert people and people[0].confidence > 0.5 and people[0].track_id == 1
    assert [b.track_id for b in second.boxes] == [b.track_id for b in first.boxes]

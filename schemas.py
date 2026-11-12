from pydantic import BaseModel, Field

class Detection(BaseModel):
    frame: int
    timestamp_seconds: float
    class_id: int
    label: str
    confidence: float = Field(ge=0, le=1)
    x1: float
    y1: float
    x2: float
    y2: float
    track_id: int | None = None
    # Approximate main colour of the box (a person's torso). Optional for older clients.
    color: str | None = None

class Keyframe(BaseModel):
    t: float
    frame: int
    labels: dict[str, int]
    image: str

class AnalysisSummary(BaseModel):
    filename: str
    duration_seconds: float
    source_fps: float
    frames_sampled: int
    frames_processed: int
    processing_seconds: float
    average_inference_fps: float
    detections_count: int
    class_counts: dict[str, int]
    # Diagnostic metrics are additive; existing clients can ignore this field.
    class_metrics: dict[str, dict[str, float | int]] = Field(default_factory=dict)
    # Size of the analysed video in pixels; detections are in these coordinates. Optional for older clients.
    frame_width: int | None = None
    frame_height: int | None = None
    detections: list[Detection]
    preview_image: str | None = None
    # Evidence frames (annotated) where what is visible changes; the video itself is not kept.
    keyframes: list[Keyframe] = Field(default_factory=list)
    # Model, thresholds and sampling used, so a report can be reproduced.
    run_config: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    note: str

class AskRequest(BaseModel):
    question: str = Field(default="", max_length=600)
    context: str = Field(min_length=1, max_length=24000)
    mode: str = Field(default="answer", pattern="^(answer|summary)$")

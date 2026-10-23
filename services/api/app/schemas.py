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
    detections: list[Detection]
    preview_image: str | None = None
    note: str

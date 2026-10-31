from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env relative to this file, not the terminal's current working directory.
# config.py lives in services/api/app/, so parents[1] is services/api/.
API_DIR = Path(__file__).resolve().parents[1]
ENV_FILE = API_DIR / ".env"

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")
    app_name: str = "Sentinel Vision API"
    model_name: str = "yolo11n.pt"
    max_upload_mb: int = 20
    max_video_seconds: int = 30
    frame_stride: int = 3
    max_analysis_frames: int = 300
    # Detector calibration controls; override safely through services/api/.env.
    confidence_threshold: float = 0.35
    iou_threshold: float = 0.45
    inference_image_size: int = 416
    allowed_origins: str = "http://localhost:3000"
    # Optional regex for Vercel preview URLs, e.g. https://sentinel-vision-.*\.vercel\.app
    allowed_origin_regex: str = ""
    # Load the detector when the server starts (instead of on the first request) so the first frame is fast.
    preload_model: bool = True
    supabase_url: str = ""
    supabase_publishable_key: str = ""

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

settings = Settings()

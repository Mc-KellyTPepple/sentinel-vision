from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
import httpx

from .config import settings
from .inference import analyze_upload, is_model_loaded, process_live_frame

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="CPU-first video analysis API for Sentinel Vision."
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.allowed_origin_regex or None,  # e.g. Vercel preview deployments
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"name": settings.app_name, "version": app.version, "docs": "/docs", "health": "/health"}

@app.get("/health")
def health():
    return {"status": "ok", "service": "sentinel-vision-api"}

@app.get("/ready")
def ready():
    # The detector (torch) is loaded lazily on the first inference request.
    return {"status": "ready", "inference_model_loaded": is_model_loaded()}

async def require_supabase_user(authorization: str | None = Header(default=None)) -> dict:
    """Validate the caller's access token with Supabase Auth; never trust a client-supplied user ID."""
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status_code=503, detail="API authentication is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the API service.")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in is required to analyze video.", headers={"WWW-Authenticate": "Bearer"})
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="A valid sign-in token is required.", headers={"WWW-Authenticate": "Bearer"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.supabase_url.rstrip('/')}/auth/v1/user",
                headers={"Authorization": f"Bearer {token}", "apikey": settings.supabase_publishable_key},
            )
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Could not verify your sign-in with Supabase. Please try again.")
    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Your sign-in is invalid or expired. Please sign in again.", headers={"WWW-Authenticate": "Bearer"})
    try:
        user = response.json()
    except ValueError:
        raise HTTPException(status_code=401, detail="Supabase returned an invalid authentication response.")
    if not isinstance(user, dict) or not user.get("id"):
        raise HTTPException(status_code=401, detail="Could not verify the signed-in user.")
    return user

@app.post("/api/v1/analyze")
async def analyze_video(file: UploadFile = File(...), _user: dict = Depends(require_supabase_user)):
    return (await analyze_upload(file)).model_dump()


MAX_LIVE_FRAME_BYTES = 2 * 1024 * 1024

@app.post("/api/v1/live/frame")
async def live_frame(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    _user: dict = Depends(require_supabase_user),
):
    """Analyze one webcam JPEG and return annotated detections for live preview."""
    if not session_id or len(session_id) > 160:
        raise HTTPException(status_code=400, detail="A valid live session ID is required.")
    content = await file.read(MAX_LIVE_FRAME_BYTES + 1)
    await file.close()
    if not content or len(content) > MAX_LIVE_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="Camera frame is empty or exceeds the 2 MB limit.")
    return await run_in_threadpool(process_live_frame, content, session_id)

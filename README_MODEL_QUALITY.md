Sentinel Vision — Model Calibration & Detection Quality Diagnostics

Purpose
- Makes detector confidence, IoU/NMS threshold, and inference image size configurable without replacing model weights.
- Adds per-class diagnostics to the analysis API response: average/min/max confidence, detections, number of processed frames containing the class, frame coverage percentage, and unique track IDs.
- Keeps current defaults (confidence 0.35 and image size 416) to avoid silently changing detection behavior. IoU defaults to 0.45.
- Diagnostics are descriptive, not calibrated probabilities or proof of an incident. Frame coverage is based on sampled/processed frames only.

Overlay files (extract to project root)
- services/api/app/config.py
- services/api/app/inference.py
- services/api/app/schemas.py

Before applying
1. Back up these three files.
2. Extract this ZIP into C:\Users\User\Documents\AI-Projects\sentinel-vision-starter and allow those three files to be replaced.
3. No database migration is required. No .env or secret file is included.
4. Restart the API server.

Optional controls in services/api/.env
CONFIDENCE_THRESHOLD=0.35
IOU_THRESHOLD=0.45
INFERENCE_IMAGE_SIZE=416

Guidance for controlled evaluation
- Try confidence 0.40 or 0.45 on the same short test clip and compare missed objects as well as false positives. Higher confidence may reduce false positives but can miss objects.
- For small/far-away objects, test image size 512 or 640; CPU inference may be slower. Values are clamped to 320–1280.
- IoU affects non-maximum suppression; change it only after comparing the same clips. Values are clamped to 0.1–0.9.
- The model weights are not retrained by this update. Keep a small fixed validation set with varied lighting, distances, motion, and empty scenes before claiming quality improvements.

Quick verification
- Start the API as usual: python -m uvicorn app.main:app --reload --port 8000
- Check http://localhost:8000/health and run an authenticated clip analysis.
- The API JSON response should now include class_metrics alongside class_counts. Existing clients that ignore unknown fields should continue to work.

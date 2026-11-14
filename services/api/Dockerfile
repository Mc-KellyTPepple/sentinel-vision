# Sentinel Vision API (CPU inference with ONNX Runtime). Used by Render (runtime: docker) and any container host.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Shared library OpenCV needs at import time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Official Ultralytics YOLO11n export (COCO, 80 classes, dynamic input size), fetched at build time so the repo
# does not have to store an 11 MB binary. Pinned by size: a changed or truncated download fails the build.
ADD https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx ./yolo11n.onnx
RUN python -c "import os,sys; n=os.path.getsize('yolo11n.onnx'); print('yolo11n.onnx', n, 'bytes'); sys.exit(n < 5_000_000)"

COPY app ./app

EXPOSE 10000
# Render sets $PORT; default keeps `docker run -p 8000:8000` working locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

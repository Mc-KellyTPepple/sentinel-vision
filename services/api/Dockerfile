# Sentinel Vision API (CPU inference). Used by Render (runtime: docker) and any container host.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    YOLO_CONFIG_DIR=/tmp/Ultralytics

# Shared libraries OpenCV needs at import time (the usual cause of "libGL.so.1 not found" on small hosts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
# Ultralytics pulls in the full opencv-python; keep exactly one OpenCV build (headless) in the image.
RUN pip install -r requirements.txt \
    && pip uninstall -y opencv-python opencv-python-headless \
    && pip install "opencv-python-headless>=4.10,<5.0"

COPY app ./app
COPY yolo11n.pt ./yolo11n.pt

EXPOSE 10000
# Render sets $PORT; default keeps `docker run -p 8000:8000` working locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

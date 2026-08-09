FROM python:3.9-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential libgl1 libglib2.0-0 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .

# Install requirements first (libreface pulls in its own torch==2.0.0 pin
# here — that's expected and fine, it gets overwritten next).
RUN pip install --no-cache-dir -r requirements.txt

# THEN force the CUDA-matched build back in, --no-deps so pip doesn't try
# to "fix" libreface's pin again. Order matters: doing this before
# requirements.txt gets silently undone by libreface's pin winning the
# dependency resolution — that's exactly what happened in the first deploy.
# Compatible with Cloud Run's L4 GPU driver (CUDA 12.2) via backward
# compatibility; runs fine CPU-only too if deployed without --gpu.
RUN pip install --no-cache-dir --force-reinstall --no-deps torch --index-url https://download.pytorch.org/whl/cu121

COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "180", "app:app"]

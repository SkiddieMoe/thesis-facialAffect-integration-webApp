FROM python:3.9-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential libgl1 libglib2.0-0 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .

# CUDA-matched PyTorch build (cu121), compatible with Cloud Run's L4 GPU
# driver (CUDA 12.2) via backward compatibility. Runs fine CPU-only too if
# deployed without --gpu, just without acceleration — no downside either way.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu121
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "180", "app:app"]

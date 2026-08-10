FROM python:3.9-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential libgl1 libglib2.0-0 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .

# Install requirements first (libreface pulls in its own torch==2.0.0 pin
# here — that's expected, it gets overwritten next).
RUN pip install --no-cache-dir -r requirements.txt

# THEN force the CUDA-matched build back in. NOT --no-deps: the cu121 wheel
# is "thin" — it doesn't bundle CUDA's .so files itself, it locates them via
# separate nvidia-cublas-cu12/nvidia-nvjitlink-cu12/etc. companion packages
# installed alongside it. Skipping those (as an earlier version of this
# Dockerfile did) leaves torch unable to find libcudart.so.12 at import
# time, crashing every route since libreface imports torch at module load.
# A few now-unused nvidia-*-cu11 packages from libreface's pin get left on
# disk — harmless, just a bit of extra image size.
RUN pip install --no-cache-dir --force-reinstall torch --index-url https://download.pytorch.org/whl/cu121

# The torch reinstall above is its own isolated pip resolution — it only
# sees torch's own loose "typing_extensions>=4.8.0" requirement and picks
# an old 4.9.0 from PyTorch's index, silently downgrading the newer
# typing_extensions that openai/pydantic_core needs (pydantic_core imports
# `Sentinel`, which doesn't exist until later typing_extensions versions).
# Bump it back up as the final step so nothing else regresses from this.
RUN pip install --no-cache-dir --upgrade typing_extensions

COPY . .

# Pre-download LibreFace's model weights during the BUILD, not at container
# startup — see warmup_libreface.py for why. Trades a slower build for
# every future cold start skipping the download entirely. Non-fatal if it
# fails; the app just falls back to downloading at runtime as before.
RUN python warmup_libreface.py

ENV PORT=8080
EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "180", "app:app"]

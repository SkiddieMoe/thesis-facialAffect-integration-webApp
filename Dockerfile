FROM python:3.9-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential libgl1 libglib2.0-0 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .

# Install requirements first (libreface pulls in its own torch==2.0.0 pin
# here — that's expected, it gets overwritten next).
RUN pip install --no-cache-dir -r requirements.txt

# THEN force the CUDA-matched build back in, pinning torch/torchvision/
# torchaudio TOGETHER at their officially paired versions (per PyTorch's own
# compatibility table) — reinstalling torch alone (as an earlier version of
# this Dockerfile did) leaves torchvision at whatever version libreface's
# own pin installed (0.15.1, matching the OLD torch 2.0.0), and a torch/
# torchvision version this far apart breaks torchvision's compiled C++
# extension ABI outright ("undefined symbol" at import time). NOT --no-deps:
# the cu121 wheel is "thin" — it doesn't bundle CUDA's .so files itself, it
# locates them via separate nvidia-cublas-cu12/nvidia-nvjitlink-cu12/etc.
# companion packages installed alongside it. A few now-unused nvidia-*-cu11
# packages from libreface's pin get left on disk — harmless, just a bit of
# extra image size.
#
# --extra-index-url, NOT --index-url: the latter REPLACES pip's normal
# index entirely, meaning pip would search ONLY download.pytorch.org for
# every transitive dependency too (typing-extensions, build tools like
# flit_core, etc.) — packages that index was never meant to fully host.
# When PyTorch's index doesn't carry a compatible wheel for one of those,
# pip falls back to a source build, which then ALSO can't find its own
# build dependencies there, and the whole install collapses. --extra-
# index-url adds PyTorch's index alongside normal PyPI instead, so the
# CUDA-specific torch/torchvision/torchaudio wheels still come from
# PyTorch's index (the only place they exist), while everything else
# resolves normally from PyPI.
RUN pip install --no-cache-dir --force-reinstall \
    torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
    --extra-index-url https://download.pytorch.org/whl/cu121

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

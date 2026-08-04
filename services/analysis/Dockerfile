FROM python:3.11-slim

# System dependencies required by librosa, essentia, and audio decoding
RUN apt-get update && apt-get install -y \
    libsndfile1 \
    ffmpeg \
    libyaml-dev \
    libfftw3-dev \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswresample-dev \
    curl \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

# Install torch/torchaudio from the CPU-only index first. The default PyPI
# wheels bundle the CUDA runtime (~2.5GB) which this service never uses --
# pinning them here means the later -r install resolves them as satisfied.
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.2.2 torchaudio==2.2.2 \
 && pip install --no-cache-dir -r requirements.txt

# Bake the CLAP checkpoint into the image so instances don't each download
# ~2GB on cold start. Overridable via CLAP_CHECKPOINT_PATH.
ENV CLAP_CHECKPOINT_PATH=/models/music_audioset_epoch_15_esc_90.14.pt
RUN mkdir -p /models && \
    curl -fsSL -o "$CLAP_CHECKPOINT_PATH" \
      https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt

COPY . .

EXPOSE 8000

# SINGLE worker, deliberately. The CLAP checkpoint is ~2GB resident and each
# uvicorn worker is a separate process with its own copy -- the previous
# --workers 16 would have needed ~32GB of RAM. Concurrency now comes from
# ANALYSIS_CONCURRENCY (a semaphore over a threadpool) inside the one process,
# which is the right shape anyway since analysis is CPU-bound.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

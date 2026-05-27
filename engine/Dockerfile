# EDGE Vision Engine v5 - Autonomous Metadata Worker
# Pipeline: FFmpeg → pHash → Mistral Vision → TMDB → Cloudinary → DB

FROM python:3.12-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies (layer-cached)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY . .

# Environment defaults
ENV ENGINE_HOST=0.0.0.0
ENV ENGINE_PORT=8900
ENV PYTHONUNBUFFERED=1

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD curl -f http://localhost:8900/api/health || exit 1

EXPOSE 8900

CMD ["python", "-m", "engine.main"]

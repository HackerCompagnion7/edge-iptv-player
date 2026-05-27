#!/usr/bin/env bash
# EDGE Vision Engine - Startup Script
# Usage: ./start.sh [--host HOST] [--port PORT]

set -euo pipefail

HOST="${ENGINE_HOST:-0.0.0.0}"
PORT="${ENGINE_PORT:-8900}"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --host) HOST="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo "================================================"
echo "  EDGE Vision Engine v4"
echo "  Host: ${HOST}  Port: ${PORT}"
echo "================================================"

# Check FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "ERROR: FFmpeg not found. Install: apt-get install ffmpeg"
    exit 1
fi
echo "  FFmpeg: $(ffmpeg -version 2>&1 | head -1)"

# Check Python packages
python3 -c "import fastapi, uvicorn, httpx, PIL, imagehash" 2>/dev/null || {
    echo "Installing core dependencies..."
    pip install -r "$(dirname "$0")/requirements.txt"
}

echo "  Starting server..."
echo "================================================"

exec python3 -m uvicorn engine.main:app \
    --host "${HOST}" \
    --port "${PORT}" \
    --workers 1 \
    --log-level info \
    --no-access-log

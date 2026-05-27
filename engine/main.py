"""EDGE Vision Engine - Autonomous Metadata Worker.

Production realtime visual intelligence for IPTV.
This is NOT a chatbot — it's a silent metadata engine.

Pipeline: Stream → FFmpeg → pHash → Mistral Vision → TMDB → Cloudinary → DB

API Endpoints:
  GET  /api/engine-status     - Engine health and capabilities
  GET  /api/health            - Simple health check
  POST /api/channel/activate  - Start monitoring a channel
  POST /api/channel/deactivate - Stop monitoring a channel
  GET  /api/channel/:id       - Get channel metadata
  GET  /api/channels          - Get all channel metadata
  POST /api/identify          - Manual content identification
  POST /api/vision-chat       - User-initiated chat with vision
  GET  /api/detection-stats   - Detection statistics
  POST /api/clear-cache       - Clear all caches
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

from .config import EngineConfig
from .database import Database
from .sampler import FrameSampler
from .scene import SceneDetector
from .cache import CacheLayer
from .tmdb_client import TMDBClient
from .cloudinary_client import CloudinaryClient
from .mistral import MistralVision, infer_content_type
from .worker import WorkerManager

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("edge.engine")

# ── Globals ────────────────────────────────────────────────────
START_TIME = time.time()
_config: Optional[EngineConfig] = None
_db: Optional[Database] = None
_sampler: Optional[FrameSampler] = None
_scene: Optional[SceneDetector] = None
_cache: Optional[CacheLayer] = None
_tmdb: Optional[TMDBClient] = None
_cloudinary: Optional[CloudinaryClient] = None
_mistral: Optional[MistralVision] = None
_workers: Optional[WorkerManager] = None


# ── Lifespan ───────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup engine components."""
    global _config, _db, _sampler, _scene, _cache, _tmdb, _cloudinary, _mistral, _workers

    _config = EngineConfig.from_env()
    _db = Database(_config)
    _cache = CacheLayer(_config)
    _sampler = FrameSampler(_config)
    _scene = SceneDetector(_config, _cache.phash)
    _tmdb = TMDBClient(_config, _cache.genre)
    _cloudinary = CloudinaryClient(_config)
    _mistral = MistralVision(_config)
    _workers = WorkerManager(
        config=_config,
        database=_db,
        sampler=_sampler,
        scene=_scene,
        cache=_cache,
        tmdb=_tmdb,
        cloudinary=_cloudinary,
        mistral=_mistral,
    )

    logger.info(
        "EDGE Vision Engine v5 started | FFmpeg=%s | TMDB=%s | Mistral=%s | Cloudinary=%s",
        _sampler.check_available(),
        _tmdb.is_configured(),
        _mistral.is_configured,
        _cloudinary.is_configured(),
    )

    yield

    # Cleanup
    _workers.stop_all()
    await _tmdb.close()
    logger.info("EDGE Vision Engine stopped")


# ── App ────────────────────────────────────────────────────────
app = FastAPI(
    title="EDGE Vision Engine",
    version="5.0.0",
    description="Autonomous metadata engine for IPTV",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ── Request/Response Models ────────────────────────────────────

class ActivateChannelRequest(BaseModel):
    channelId: str
    channelName: str = ""
    category: str = "default"
    streamUrl: str = ""


class DeactivateChannelRequest(BaseModel):
    channelId: str


class ManualIdentifyRequest(BaseModel):
    channelId: str
    title: str
    type: str = "movie"
    year: Optional[str] = None


class VisionChatRequest(BaseModel):
    question: str
    frame: Optional[str] = None
    channelName: Optional[str] = None
    category: Optional[str] = None
    channelId: Optional[str] = None


class DetectRequest(BaseModel):
    channelId: str
    category: str = "default"
    frame: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


# ── Health & Status ────────────────────────────────────────────

@app.get("/api/engine-status")
async def engine_status():
    """Get engine status and component availability."""
    features = ["scene_change_detection", "metadata_detection"]

    tmdb_ok = _tmdb.is_configured()
    ffmpeg_ok = _sampler.check_available()
    mistral_ok = _mistral.is_configured
    cloudinary_ok = _cloudinary.is_configured()

    if tmdb_ok:
        features.extend(["tmdb_search", "tmdb_genre_detection", "tmdb_poster"])
    if mistral_ok:
        features.extend(["vision_identification", "vision_chat"])
    if cloudinary_ok:
        features.append("cloudinary_posters")
    if ffmpeg_ok:
        features.append("ffmpeg_frame_capture")

    features.extend(["autonomous_worker", "manual_identification", "database_cache"])

    return {
        "version": "v5",
        "status": "running",
        "mode": "autonomous_worker",
        "tmdb": tmdb_ok,
        "mistral": mistral_ok,
        "cloudinary": cloudinary_ok,
        "ffmpeg": ffmpeg_ok,
        "features": features,
        "workers": _workers.get_status(),
        "dbStats": _db.get_stats(),
        "cost": {
            "dailyBudget": _config.daily_budget,
            "mistralSpent": round(_mistral.daily_cost, 4),
            "mistralRemaining": round(max(0, _config.daily_budget - _mistral.daily_cost), 4),
        },
        "uptime": round(time.time() - START_TIME, 1),
    }


@app.get("/api/health")
async def health():
    """Simple health check."""
    return {"status": "ok", "uptime": round(time.time() - START_TIME, 1)}


# ── Channel Management ─────────────────────────────────────────

@app.post("/api/channel/activate")
async def activate_channel(req: ActivateChannelRequest):
    """Activate a channel for autonomous monitoring.

    Called when user enters a channel.
    Worker starts capturing frames and identifying content.
    """
    if not _config.is_category_active(req.category):
        # Non-active category — still register but don't start worker
        _db.register_channel(
            req.channelId, req.channelName, req.category, req.streamUrl
        )
        return {
            "success": True,
            "workerStarted": False,
            "reason": f"Category '{req.category}' is not active for detection",
        }

    worker = _workers.activate_channel(
        req.channelId, req.channelName, req.category, req.streamUrl
    )

    # Return current metadata if available
    channel = _db.get_channel(req.channelId)

    return {
        "success": True,
        "workerStarted": True,
        "workerState": worker.state,
        "metadata": channel.to_dict() if channel and channel.current_title else None,
    }


@app.post("/api/channel/deactivate")
async def deactivate_channel(req: DeactivateChannelRequest):
    """Deactivate a channel.

    Called when user leaves a channel.
    Worker stops and resources are freed.
    """
    _workers.deactivate_channel(req.channelId)
    return {"success": True}


@app.get("/api/channel/{channel_id}")
async def get_channel_metadata(channel_id: str):
    """Get current metadata for a channel.

    Frontend polls this to display what's playing.
    """
    channel = _db.get_channel(channel_id)
    if channel:
        return {"success": True, "data": channel.to_dict()}
    return {"success": False, "error": "Channel not found"}


@app.get("/api/channels")
async def get_all_channels():
    """Get metadata for all channels.

    Used by frontend for batch updates.
    """
    return {"success": True, "data": _db.get_all_metadata()}


# ── Manual Identification ─────────────────────────────────────

@app.post("/api/identify")
async def manual_identify(req: ManualIdentifyRequest):
    """Manually identify content for a channel (high confidence)."""
    # Get TMDB data
    poster_url = None
    backdrop_url = None
    overview = None
    rating = None
    tmdb_id = None

    if _tmdb.is_configured():
        tmdb_data = await _tmdb.search(req.title, req.type, req.year)
        if tmdb_data:
            poster_url = tmdb_data.get("poster")
            backdrop_url = tmdb_data.get("backdrop")
            overview = tmdb_data.get("overview")
            rating = tmdb_data.get("rating")
            tmdb_id = tmdb_data.get("tmdb_id")

    _db.update_detection(
        channel_id=req.channelId,
        title=req.title,
        content_type=req.type,
        confidence=0.95,
        source="manual",
        year=req.year,
        poster=poster_url,
        backdrop=backdrop_url,
        overview=overview,
        rating=rating,
        tmdb_id=tmdb_id,
    )

    channel = _db.get_channel(req.channelId)
    return {"success": True, "data": channel.to_dict() if channel else None}


# ── Detection (compatibility with Worker frontend) ─────────────

@app.post("/api/detect")
async def detect_content(req: DetectRequest):
    """Detect content for a channel.

    Compatibility endpoint for existing frontend code.
    Also registers channel if not already active.
    """
    # If channel has a stream URL, use autonomous worker
    if req.metadata and req.metadata.get("streamUrl"):
        worker = _workers.activate_channel(
            req.channelId,
            req.metadata.get("title", ""),
            req.category,
            req.metadata["streamUrl"],
        )
        channel = _db.get_channel(req.channelId)
        if channel and channel.current_title:
            return {"success": True, "data": channel.to_dict()}

    # Fallback: one-shot detection with provided frame
    if req.frame and _mistral.is_configured:
        try:
            img_bytes = base64.b64decode(req.frame)
            frame_image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        except Exception:
            frame_image = None

        channel_name = req.metadata.get("title", "") if req.metadata else ""
        result = await _mistral.identify(
            frame_base64=req.frame,
            channel_name=channel_name,
            category=req.category,
        )

        if result and result.is_valid:
            # Fetch TMDB data
            poster_url = None
            backdrop_url = None
            overview = None
            rating = None
            tmdb_id = None

            if _tmdb.is_configured():
                tmdb_data = await _tmdb.search(
                    result.title, result.content_type, result.year
                )
                if tmdb_data:
                    poster_url = tmdb_data.get("poster")
                    backdrop_url = tmdb_data.get("backdrop")
                    overview = tmdb_data.get("overview")
                    rating = tmdb_data.get("rating")
                    tmdb_id = tmdb_data.get("tmdb_id")

            _db.update_detection(
                channel_id=req.channelId,
                title=result.title,
                content_type=result.content_type,
                confidence=result.confidence,
                source="vision",
                year=result.year,
                poster=poster_url,
                backdrop=backdrop_url,
                overview=overview,
                rating=rating,
                tmdb_id=tmdb_id,
            )

            channel = _db.get_channel(req.channelId)
            if channel:
                return {"success": True, "data": channel.to_dict()}

    return {"success": False, "error": "No detection result"}


# ── Vision Chat (user-initiated) ──────────────────────────────

@app.post("/api/vision-chat")
async def vision_chat(req: VisionChatRequest):
    """AI chat with vision capability.

    Only for user-initiated questions.
    The autonomous worker does NOT use this.
    """
    if not req.question:
        raise HTTPException(400, "question required")

    # Priority 1: Vision with frame
    if req.frame and _mistral.is_configured:
        result = await _mistral.chat(
            question=req.question,
            frame_base64=req.frame,
            channel_name=req.channelName or "",
            category=req.category or "default",
        )
        if result:
            # Try to extract title for TMDB enrichment
            import re
            title_match = re.search(r'"([^"]+)"\s*\(?((?:19|20)\d{2})\)?', result["response"])
            if title_match:
                detected_title = title_match.group(1)
                detected_year = title_match.group(2)

                if _tmdb.is_configured():
                    tmdb_data = await _tmdb.search(detected_title, "movie", detected_year)
                    if tmdb_data:
                        if tmdb_data.get("overview"):
                            result["response"] += f"\n\nSinopsis: {tmdb_data['overview'][:150]}..."
                        if tmdb_data.get("rating"):
                            result["response"] += f" | Rating: {tmdb_data['rating']:.1f}/10"

                # Update channel metadata
                if req.channelId and detected_title:
                    _db.update_detection(
                        channel_id=req.channelId,
                        title=detected_title,
                        content_type=infer_content_type(detected_title),
                        confidence=0.85,
                        source="vision_chat",
                        year=detected_year,
                    )

            return result

    # Priority 2: TMDB fallback
    channel_name = req.channelName or ""
    category = req.category or "default"
    if channel_name or category:
        genre_result = await _tmdb.detect_from_channel_name(channel_name, category)
        if genre_result and genre_result.get("candidates"):
            top5 = ", ".join(
                f"{c['title']} ({c.get('year', '?')})"
                for c in genre_result["candidates"][:5]
            )
            return {
                "response": f"Segun el canal '{channel_name}' ({category}), las peliculas mas probables son: {top5}",
                "source": "tmdb_fallback",
                "candidates": genre_result["candidates"],
            }

    return {
        "response": "Configura MISTRAL_API_KEY para activar vision AI.",
        "source": "fallback",
    }


# ── Now Playing ────────────────────────────────────────────────

@app.get("/api/now-playing")
async def now_playing(channelId: str):
    """Get cached detection for a channel."""
    channel = _db.get_channel(channelId)
    if channel and channel.current_title:
        return {"success": True, "data": channel.to_dict()}
    return {"success": False, "error": "No detection cached"}


@app.post("/api/batch-detect")
async def batch_detect(channelIds: List[str]):
    """Get metadata for multiple channels."""
    results = {}
    for cid in channelIds:
        channel = _db.get_channel(cid)
        if channel and channel.current_title:
            results[cid] = channel.to_dict()
    return {"success": True, "data": results}


# ── TMDB Endpoints ─────────────────────────────────────────────

@app.get("/api/poster")
async def get_poster(title: str, type: str = "movie", year: Optional[str] = None):
    """Get poster and metadata for a title."""
    # Check cache first
    cached = _db.get_cached_movie(title, year, type)
    if cached and cached.poster_url:
        return {"success": True, "data": {
            "poster": cached.poster_url,
            "backdrop": cached.backdrop_url,
            "overview": cached.overview,
            "rating": cached.rating,
            "tmdb_id": cached.tmdb_id,
        }}

    result = await _tmdb.search(title, type, year)
    if result:
        return {"success": True, "data": result}
    return {"success": False, "error": "Not found"}


@app.get("/api/tmdb-trending")
async def tmdb_trending(type: str = "movie", window: str = "week"):
    """Get trending content from TMDB."""
    items = await _tmdb.get_trending(type, window)
    return {"type": type, "window": window, "results": items}


@app.get("/api/tmdb-genre")
async def tmdb_genre(genreIds: str, page: int = 1):
    """Get movies by TMDB genre IDs."""
    ids = [int(i.strip()) for i in genreIds.split(",") if i.strip().isdigit()]
    if not ids:
        raise HTTPException(400, "genreIds required")
    movies = await _tmdb.discover_by_genre(ids, page)
    return {"genreIds": ids, "page": page, "results": movies}


# ── Stats & Cache ──────────────────────────────────────────────

@app.get("/api/detection-stats")
async def detection_stats():
    """Get detection statistics."""
    db_stats = _db.get_stats()
    return {
        **db_stats,
        "workers": _workers.get_status(),
        "caches": _cache.stats(),
        "cost": {
            "mistralSpent": round(_mistral.daily_cost, 4),
            "mistralRemaining": round(max(0, _config.daily_budget - _mistral.daily_cost), 4),
            "budget": _config.daily_budget,
        },
    }


@app.post("/api/clear-cache")
async def clear_cache():
    """Clear all caches."""
    _cache.poster.clear()
    _cache.detection.clear()
    _cache.embedding.clear()
    _cache.ocr.clear()
    _cache.genre.clear()
    _cache.phash.clear()
    return {"success": True, "message": "All caches cleared"}

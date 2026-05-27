"""Data models for EDGE Vision Engine.

Pydantic models for API I/O and internal data structures.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


# ── Enums ──────────────────────────────────────────────────────

class ContentType(str, Enum):
    MOVIE = "movie"
    SERIES = "series"
    SPORTS = "sports"
    NEWS = "news"
    MUSIC = "music"
    KIDS = "kids"
    UNKNOWN = "unknown"


class DetectionSource(str, Enum):
    METADATA = "metadata"
    OCR = "ocr"
    CLIP = "clip"
    VISION = "vision"
    EPG = "epg"
    TMDB_GENRE = "tmdb_genre"
    MANUAL = "manual"
    FUSION = "fusion"


# ── Internal Data Classes ──────────────────────────────────────

@dataclass
class FrameSample:
    """A sampled frame from a live stream."""
    channel_id: str
    image: Any  # PIL.Image.Image
    phash: str = ""
    timestamp: float = 0.0


@dataclass
class OCRResult:
    """OCR extraction result."""
    text: str
    confidence: float
    bbox: Optional[List[float]] = None


@dataclass
class EmbeddingResult:
    """Visual embedding result."""
    embedding: List[float]
    model: str = ""
    timestamp: float = 0.0


@dataclass
class DetectionResult:
    """Fused detection result from the pipeline."""
    title: str
    content_type: ContentType
    confidence: float
    source: DetectionSource
    year: Optional[str] = None
    genre: List[str] = field(default_factory=list)
    poster: Optional[str] = None
    backdrop: Optional[str] = None
    overview: Optional[str] = None
    rating: Optional[float] = None
    tmdb_id: Optional[int] = None
    alternatives: List[Dict[str, Any]] = field(default_factory=list)
    ocr_texts: List[str] = field(default_factory=list)
    scene_changed: bool = False
    channel_id: str = ""
    timestamp: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "title": self.title,
            "type": self.content_type.value,
            "confidence": round(self.confidence, 3),
            "source": self.source.value,
            "year": self.year,
            "genre": self.genre,
            "poster": self.poster,
            "backdrop": self.backdrop,
            "overview": self.overview,
            "rating": self.rating,
            "tmdb_id": self.tmdb_id,
            "alternatives": self.alternatives,
            "ocr_texts": self.ocr_texts,
            "sceneChanged": self.scene_changed,
            "channelId": self.channel_id,
            "timestamp": self.timestamp,
        }


@dataclass
class ChannelState:
    """Per-channel tracking state."""
    channel_id: str
    channel_name: str = ""
    category: str = "default"
    last_phash: str = ""
    last_detection: Optional[DetectionResult] = None
    last_frame_time: float = 0.0
    detection_count: int = 0
    last_source: str = ""
    last_ocr_texts: List[str] = field(default_factory=list)
    last_embedding: Optional[List[float]] = None
    stream_url: str = ""
    scanning: bool = False


# ── API Request/Response Models ────────────────────────────────

class DetectRequest(BaseModel):
    """Request for content detection."""
    channelId: str
    category: str = "default"
    frame: Optional[str] = None  # base64 encoded JPEG
    metadata: Optional[Dict[str, Any]] = None


class VisionChatRequest(BaseModel):
    """Request for vision-based chat."""
    question: str
    frame: Optional[str] = None
    channelName: Optional[str] = None
    category: Optional[str] = None
    channelId: Optional[str] = None


class RegisterChannelRequest(BaseModel):
    """Register a channel for continuous scanning."""
    channelId: str
    channelName: str = ""
    category: str = "default"
    streamUrl: str = ""


class ManualIdentifyRequest(BaseModel):
    """Manual identification of content."""
    channelId: str
    title: str
    type: str = "movie"
    year: Optional[str] = None
    channelName: Optional[str] = None
    category: Optional[str] = None


class DetectionResponse(BaseModel):
    """API response for detection results."""
    success: bool = True
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class EngineStatusResponse(BaseModel):
    """Engine status response."""
    version: str = "v4"
    status: str = "running"
    tmdb: bool = False
    mistral: bool = False
    paddleocr: bool = False
    openclip: bool = False
    ffmpeg: bool = False
    features: List[str] = []
    channels: int = 0
    uptime: float = 0.0

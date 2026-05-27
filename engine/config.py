"""EDGE Vision Engine Configuration.

Single source of truth for all engine parameters.
No magic numbers. No scattered config.
Autonomous metadata worker — not a chatbot.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Set
import os


@dataclass(frozen=True)
class EngineConfig:
    """Immutable engine configuration."""

    # ── FFmpeg Sampler ──────────────────────────────────────────
    ffmpeg_timeout: int = 12                # seconds per frame extraction
    ffmpeg_quality: int = 2                 # JPEG quality (1-31, lower=better)
    ffmpeg_scale: float = 0.5               # downscale factor for extraction
    sample_interval_base: int = 30          # default seconds between samples

    # ── Scene Change (pHash) ───────────────────────────────────
    phash_hash_size: int = 8                # hash size in bits
    phash_threshold: int = 10               # hamming distance: scene changed
    phash_high_threshold: int = 18          # hamming distance: force analysis

    # ── TMDB ───────────────────────────────────────────────────
    tmdb_api_key: str = ""
    tmdb_access_token: str = ""
    tmdb_base_url: str = "https://api.themoviedb.org/3"
    tmdb_image_base: str = "https://image.tmdb.org/t/p"
    tmdb_timeout: int = 8                   # seconds
    tmdb_poster_size: str = "w500"
    tmdb_backdrop_size: str = "w780"

    # ── Mistral Vision ─────────────────────────────────────────
    mistral_api_key: str = ""
    mistral_model: str = "pixtral-12b-2409"
    mistral_timeout: int = 20
    mistral_confidence_min: float = 0.75    # reject detections below this

    # ── Cloudinary ─────────────────────────────────────────────
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""
    cloudinary_folder: str = "edge-tv/posters"

    # ── Database ───────────────────────────────────────────────
    database_url: str = ""                  # PostgreSQL URL or empty for SQLite
    database_path: str = "edge_metadata.db" # SQLite fallback path

    # ── Cache ──────────────────────────────────────────────────
    cache_poster_ttl: int = 86400           # 24h
    cache_detection_ttl: int = 3600         # 1h
    cache_genre_ttl: int = 1800             # 30min
    cache_max_size: int = 2000              # max entries per cache

    # ── Autonomous Worker Intervals (seconds) ──────────────────
    worker_intervals: Dict[str, int] = field(default_factory=lambda: {
        "movie": 30,       # movie channels: check every 30s
        "kids": 45,        # kids channels: check every 45s
        "default": 60,     # everything else: 60s
    })

    # ── Categories that get dynamic detection ──────────────────
    active_categories: Set[str] = field(default_factory=lambda: {
        "movie", "kids",
    })

    # ── Categories to IGNORE (no detection) ────────────────────
    ignore_categories: Set[str] = field(default_factory=lambda: {
        "news", "sports", "music", "radio", "francais",
    })

    # ── Confidence Thresholds ──────────────────────────────────
    confidence_accept: float = 0.55         # minimum to update UI
    confidence_poster: float = 0.60         # minimum to fetch poster

    # ── Cost Governor ──────────────────────────────────────────
    daily_budget: float = 5.0               # USD
    cost_vision_call: float = 0.0025        # per vision API call

    # ── Pipeline Control ───────────────────────────────────────
    max_concurrent_workers: int = 3         # parallel channel monitors
    analysis_timeout: int = 25              # total analysis timeout
    sleep_after_success: int = 180          # 3min sleep after successful ID
    sleep_after_fail: int = 60              # 1min sleep after failed detection
    max_retries: int = 3                    # max retries before giving up

    # ── Server ─────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8900
    cors_origins: List[str] = field(default_factory=lambda: ["*"])

    @classmethod
    def from_env(cls) -> "EngineConfig":
        """Load configuration from environment variables."""
        return cls(
            tmdb_api_key=os.getenv("TMDB_API_KEY", ""),
            tmdb_access_token=os.getenv("TMDB_ACCESS_TOKEN", ""),
            mistral_api_key=os.getenv("MISTRAL_API_KEY", os.getenv("MISTRAL_API", "")),
            cloudinary_cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME", ""),
            cloudinary_api_key=os.getenv("CLOUDINARY_API_KEY", ""),
            cloudinary_api_secret=os.getenv("CLOUDINARY_API_SECRET", ""),
            cloudinary_folder=os.getenv("CLOUDINARY_FOLDER", "edge-tv/posters"),
            database_url=os.getenv("DATABASE_URL", ""),
            database_path=os.getenv("DATABASE_PATH", "edge_metadata.db"),
            host=os.getenv("ENGINE_HOST", "0.0.0.0"),
            port=int(os.getenv("ENGINE_PORT", "8900")),
        )

    @property
    def cloudinary_configured(self) -> bool:
        return bool(self.cloudinary_cloud_name and self.cloudinary_api_key and self.cloudinary_api_secret)

    @property
    def tmdb_configured(self) -> bool:
        return bool(self.tmdb_api_key or self.tmdb_access_token)

    @property
    def mistral_configured(self) -> bool:
        return bool(self.mistral_api_key)

    def is_category_active(self, category: str) -> bool:
        """Check if a category should get dynamic detection."""
        cat_lower = category.lower()
        if cat_lower in self.ignore_categories:
            return False
        # Movie subcategories are also active
        if cat_lower in ("movies", "movie", "cine", "terror", "horror",
                         "action", "comedia", "thriller", "drama", "romance",
                         "scifi", "western", "crime", "classic", "premiere"):
            return True
        if cat_lower in self.active_categories:
            return True
        return False

    def get_worker_interval(self, category: str) -> int:
        """Get monitoring interval for a category."""
        cat_lower = category.lower()
        if cat_lower in ("movies", "movie", "cine", "terror", "horror",
                         "action", "comedia", "thriller", "drama"):
            return self.worker_intervals.get("movie", 30)
        if cat_lower in ("kids", "infantil", "cartoon"):
            return self.worker_intervals.get("kids", 45)
        return self.worker_intervals.get("default", 60)

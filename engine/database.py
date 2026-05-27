"""EDGE TV Metadata Database.

SQLite (default) or PostgreSQL for persistent metadata.
Stores channel metadata, detection history, and poster cache.

CRITICAL: This is the source of truth for what's playing.
Frontend reads from here. Worker writes here.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
import threading
from contextlib import contextmanager
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field

logger = logging.getLogger("edge.engine.database")


@dataclass
class ChannelMetadata:
    """Persistent metadata for a channel."""
    channel_id: str
    channel_name: str = ""
    category: str = "default"
    stream_url: str = ""
    current_title: str = ""
    current_year: Optional[str] = None
    current_type: str = "unknown"
    current_poster: Optional[str] = None
    current_backdrop: Optional[str] = None
    current_overview: Optional[str] = None
    current_rating: Optional[float] = None
    current_tmdb_id: Optional[int] = None
    confidence: float = 0.0
    source: str = ""
    detected_at: float = 0.0
    poster_cloudinary_id: Optional[str] = None  # Cloudinary public_id for deletion
    is_active: bool = False
    last_phash: str = ""
    last_frame_time: float = 0.0
    detection_count: int = 0
    last_error: str = ""
    retry_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "channelId": self.channel_id,
            "channelName": self.channel_name,
            "category": self.category,
            "streamUrl": self.stream_url,
            "currentTitle": self.current_title,
            "currentYear": self.current_year,
            "currentType": self.current_type,
            "currentPoster": self.current_poster,
            "currentBackdrop": self.current_backdrop,
            "currentOverview": self.current_overview,
            "currentRating": self.current_rating,
            "currentTmdbId": self.current_tmdb_id,
            "confidence": round(self.confidence, 3),
            "source": self.source,
            "detectedAt": self.detected_at,
            "isActive": self.is_active,
            "detectionCount": self.detection_count,
            "lastError": self.last_error,
        }


@dataclass
class MovieCache:
    """Cached movie entry for poster reuse."""
    title: str
    year: Optional[str] = None
    type: str = "movie"
    poster_url: Optional[str] = None
    backdrop_url: Optional[str] = None
    overview: Optional[str] = None
    rating: Optional[float] = None
    tmdb_id: Optional[int] = None
    cloudinary_id: Optional[str] = None
    created_at: float = 0.0


class Database:
    """Thread-safe metadata database.

    Uses SQLite by default (zero-config, file-based).
    Optionally PostgreSQL if DATABASE_URL is set.
    """

    def __init__(self, config):
        self._config = config
        self._lock = threading.RLock()
        self._db_path = config.database_path
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        """Get a thread-local database connection."""
        conn = sqlite3.connect(self._db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_db(self) -> None:
        """Create tables if they don't exist."""
        with self._lock:
            conn = self._get_conn()
            try:
                conn.executescript("""
                    CREATE TABLE IF NOT EXISTS channel_metadata (
                        channel_id TEXT PRIMARY KEY,
                        channel_name TEXT DEFAULT '',
                        category TEXT DEFAULT 'default',
                        stream_url TEXT DEFAULT '',
                        current_title TEXT DEFAULT '',
                        current_year TEXT,
                        current_type TEXT DEFAULT 'unknown',
                        current_poster TEXT,
                        current_backdrop TEXT,
                        current_overview TEXT,
                        current_rating REAL,
                        current_tmdb_id INTEGER,
                        confidence REAL DEFAULT 0.0,
                        source TEXT DEFAULT '',
                        detected_at REAL DEFAULT 0.0,
                        poster_cloudinary_id TEXT,
                        is_active INTEGER DEFAULT 0,
                        last_phash TEXT DEFAULT '',
                        last_frame_time REAL DEFAULT 0.0,
                        detection_count INTEGER DEFAULT 0,
                        last_error TEXT DEFAULT '',
                        retry_count INTEGER DEFAULT 0
                    );

                    CREATE TABLE IF NOT EXISTS movie_cache (
                        title TEXT NOT NULL,
                        year TEXT DEFAULT '',
                        type TEXT DEFAULT 'movie',
                        poster_url TEXT,
                        backdrop_url TEXT,
                        overview TEXT,
                        rating REAL,
                        tmdb_id INTEGER,
                        cloudinary_id TEXT,
                        created_at REAL DEFAULT 0.0,
                        PRIMARY KEY (title, year, type)
                    );

                    CREATE INDEX IF NOT EXISTS idx_channel_active
                        ON channel_metadata(is_active);
                    CREATE INDEX IF NOT EXISTS idx_channel_category
                        ON channel_metadata(category);
                    CREATE INDEX IF NOT EXISTS idx_movie_title
                        ON movie_cache(title);
                """)
                conn.commit()
                logger.info("Database initialized: %s", self._db_path)
            finally:
                conn.close()

    # ── Channel Metadata ───────────────────────────────────────

    def register_channel(
        self,
        channel_id: str,
        channel_name: str = "",
        category: str = "default",
        stream_url: str = "",
    ) -> ChannelMetadata:
        """Register or update a channel for monitoring."""
        with self._lock:
            conn = self._get_conn()
            try:
                existing = conn.execute(
                    "SELECT * FROM channel_metadata WHERE channel_id = ?",
                    (channel_id,),
                ).fetchone()

                if existing:
                    # Update existing channel
                    conn.execute("""
                        UPDATE channel_metadata
                        SET channel_name = ?, category = ?, stream_url = ?,
                            is_active = 1, last_error = ''
                        WHERE channel_id = ?
                    """, (channel_name, category, stream_url, channel_id))
                else:
                    # Insert new channel
                    conn.execute("""
                        INSERT INTO channel_metadata
                        (channel_id, channel_name, category, stream_url, is_active)
                        VALUES (?, ?, ?, ?, 1)
                    """, (channel_id, channel_name, category, stream_url))

                conn.commit()
                return self.get_channel(channel_id)
            finally:
                conn.close()

    def deactivate_channel(self, channel_id: str) -> None:
        """Mark channel as inactive (user left)."""
        with self._lock:
            conn = self._get_conn()
            try:
                conn.execute(
                    "UPDATE channel_metadata SET is_active = 0 WHERE channel_id = ?",
                    (channel_id,),
                )
                conn.commit()
            finally:
                conn.close()

    def get_channel(self, channel_id: str) -> Optional[ChannelMetadata]:
        """Get metadata for a specific channel."""
        conn = self._get_conn()
        try:
            row = conn.execute(
                "SELECT * FROM channel_metadata WHERE channel_id = ?",
                (channel_id,),
            ).fetchone()
            if row:
                return self._row_to_channel(row)
            return None
        finally:
            conn.close()

    def get_active_channels(self) -> List[ChannelMetadata]:
        """Get all active channels."""
        conn = self._get_conn()
        try:
            rows = conn.execute(
                "SELECT * FROM channel_metadata WHERE is_active = 1"
            ).fetchall()
            return [self._row_to_channel(r) for r in rows]
        finally:
            conn.close()

    def get_channels_by_category(self, category: str) -> List[ChannelMetadata]:
        """Get channels by category."""
        conn = self._get_conn()
        try:
            rows = conn.execute(
                "SELECT * FROM channel_metadata WHERE category = ?",
                (category,),
            ).fetchall()
            return [self._row_to_channel(r) for r in rows]
        finally:
            conn.close()

    def update_detection(
        self,
        channel_id: str,
        title: str,
        content_type: str = "unknown",
        confidence: float = 0.0,
        source: str = "",
        year: Optional[str] = None,
        poster: Optional[str] = None,
        backdrop: Optional[str] = None,
        overview: Optional[str] = None,
        rating: Optional[float] = None,
        tmdb_id: Optional[int] = None,
        cloudinary_id: Optional[str] = None,
        phash: str = "",
    ) -> None:
        """Update channel with new detection result.

        This is the main write path from the autonomous worker.
        """
        with self._lock:
            conn = self._get_conn()
            try:
                now = time.time()
                conn.execute("""
                    UPDATE channel_metadata
                    SET current_title = ?, current_year = ?, current_type = ?,
                        current_poster = ?, current_backdrop = ?,
                        current_overview = ?, current_rating = ?,
                        current_tmdb_id = ?, confidence = ?,
                        source = ?, detected_at = ?,
                        poster_cloudinary_id = ?,
                        last_phash = ?, last_frame_time = ?,
                        detection_count = detection_count + 1,
                        retry_count = 0, last_error = ''
                    WHERE channel_id = ?
                """, (
                    title, year, content_type,
                    poster, backdrop,
                    overview, rating,
                    tmdb_id, confidence,
                    source, now,
                    cloudinary_id,
                    phash, now,
                    channel_id,
                ))
                conn.commit()
                logger.info(
                    "Updated channel %s: %s (%s) confidence=%.2f source=%s",
                    channel_id, title, year or "?", confidence, source,
                )
            finally:
                conn.close()

    def update_phash(self, channel_id: str, phash: str) -> None:
        """Update just the phash (lightweight, frequent operation)."""
        with self._lock:
            conn = self._get_conn()
            try:
                conn.execute(
                    "UPDATE channel_metadata SET last_phash = ?, last_frame_time = ? WHERE channel_id = ?",
                    (phash, time.time(), channel_id),
                )
                conn.commit()
            finally:
                conn.close()

    def record_error(self, channel_id: str, error: str) -> None:
        """Record an error for a channel."""
        with self._lock:
            conn = self._get_conn()
            try:
                conn.execute("""
                    UPDATE channel_metadata
                    SET last_error = ?, retry_count = retry_count + 1
                    WHERE channel_id = ?
                """, (error[:200], channel_id))
                conn.commit()
            finally:
                conn.close()

    # ── Movie Cache ────────────────────────────────────────────

    def cache_movie(
        self,
        title: str,
        year: Optional[str] = None,
        type: str = "movie",
        poster_url: Optional[str] = None,
        backdrop_url: Optional[str] = None,
        overview: Optional[str] = None,
        rating: Optional[float] = None,
        tmdb_id: Optional[int] = None,
        cloudinary_id: Optional[str] = None,
    ) -> None:
        """Cache a movie's metadata for reuse."""
        with self._lock:
            conn = self._get_conn()
            try:
                conn.execute("""
                    INSERT OR REPLACE INTO movie_cache
                    (title, year, type, poster_url, backdrop_url, overview,
                     rating, tmdb_id, cloudinary_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    title, year, type, poster_url, backdrop_url,
                    overview, rating, tmdb_id, cloudinary_id, time.time(),
                ))
                conn.commit()
            finally:
                conn.close()

    def get_cached_movie(
        self, title: str, year: Optional[str] = None, type: str = "movie"
    ) -> Optional[MovieCache]:
        """Look up a cached movie by title."""
        conn = self._get_conn()
        try:
            row = conn.execute(
                "SELECT * FROM movie_cache WHERE title = ? AND COALESCE(year, '') = ? AND type = ?",
                (title, year or "", type),
            ).fetchone()
            if row:
                return MovieCache(
                    title=row["title"],
                    year=row["year"],
                    type=row["type"],
                    poster_url=row["poster_url"],
                    backdrop_url=row["backdrop_url"],
                    overview=row["overview"],
                    rating=row["rating"],
                    tmdb_id=row["tmdb_id"],
                    cloudinary_id=row["cloudinary_id"],
                    created_at=row["created_at"],
                )
            return None
        finally:
            conn.close()

    # ── Batch Reads ────────────────────────────────────────────

    def get_all_metadata(self) -> Dict[str, Dict[str, Any]]:
        """Get all channel metadata as a dict (for frontend batch reads)."""
        conn = self._get_conn()
        try:
            rows = conn.execute("SELECT * FROM channel_metadata").fetchall()
            return {r["channel_id"]: self._row_to_channel(r).to_dict() for r in rows}
        finally:
            conn.close()

    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics."""
        conn = self._get_conn()
        try:
            channels = conn.execute("SELECT COUNT(*) FROM channel_metadata").fetchone()[0]
            active = conn.execute("SELECT COUNT(*) FROM channel_metadata WHERE is_active = 1").fetchone()[0]
            detected = conn.execute("SELECT COUNT(*) FROM channel_metadata WHERE current_title != ''").fetchone()[0]
            cached_movies = conn.execute("SELECT COUNT(*) FROM movie_cache").fetchone()[0]
            sources = {}
            for row in conn.execute("SELECT source, COUNT(*) as cnt FROM channel_metadata WHERE source != '' GROUP BY source"):
                sources[row["source"]] = row["cnt"]
            return {
                "totalChannels": channels,
                "activeChannels": active,
                "detectedChannels": detected,
                "cachedMovies": cached_movies,
                "sources": sources,
            }
        finally:
            conn.close()

    # ── Helpers ────────────────────────────────────────────────

    @staticmethod
    def _row_to_channel(row: sqlite3.Row) -> ChannelMetadata:
        return ChannelMetadata(
            channel_id=row["channel_id"],
            channel_name=row["channel_name"] or "",
            category=row["category"] or "default",
            stream_url=row["stream_url"] or "",
            current_title=row["current_title"] or "",
            current_year=row["current_year"],
            current_type=row["current_type"] or "unknown",
            current_poster=row["current_poster"],
            current_backdrop=row["current_backdrop"],
            current_overview=row["current_overview"],
            current_rating=row["current_rating"],
            current_tmdb_id=row["current_tmdb_id"],
            confidence=row["confidence"] or 0.0,
            source=row["source"] or "",
            detected_at=row["detected_at"] or 0.0,
            poster_cloudinary_id=row["poster_cloudinary_id"],
            is_active=bool(row["is_active"]),
            last_phash=row["last_phash"] or "",
            last_frame_time=row["last_frame_time"] or 0.0,
            detection_count=row["detection_count"] or 0,
            last_error=row["last_error"] or "",
            retry_count=row["retry_count"] or 0,
        )

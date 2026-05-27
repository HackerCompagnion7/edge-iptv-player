"""EDGE TV Autonomous Worker.

This is NOT a chatbot. This is a silent autonomous metadata engine.

It watches live channels, detects content changes, identifies what's playing,
fetches posters, and updates metadata — all without user interaction.

Pipeline:
  Live Stream → FFmpeg Frame → pHash Scene Change → Mistral Vision
  → TMDB Poster → Cloudinary Upload → Database Update → Sleep

The worker only acts when:
  - User enters a channel
  - Scene changed significantly
  - Movie likely changed
  - Metadata expired

Otherwise: SLEEP. Save resources. Minimize API calls.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
from typing import Any, Dict, Optional

from PIL import Image

from .config import EngineConfig
from .database import Database, ChannelMetadata
from .sampler import FrameSampler
from .scene import SceneDetector
from .cache import CacheLayer
from .tmdb_client import TMDBClient
from .cloudinary_client import CloudinaryClient
from .mistral import MistralVision, infer_content_type

logger = logging.getLogger("edge.engine.worker")


class AutonomousWorker:
    """Autonomous metadata engine for a single channel.

    One worker per active channel. Workers are created when users enter
    channels and destroyed when users leave.

    Lifecycle:
      IDLE → ACTIVE → MONITORING → DETECTED → SLEEPING → IDLE

    States:
      - IDLE: Channel not being watched
      - ACTIVE: User just entered, starting monitor
      - MONITORING: Checking frames periodically
      - DETECTED: Successfully identified content
      - SLEEPING: Long sleep after successful detection
    """

    def __init__(
        self,
        config: EngineConfig,
        database: Database,
        sampler: FrameSampler,
        scene: SceneDetector,
        cache: CacheLayer,
        tmdb: TMDBClient,
        cloudinary: CloudinaryClient,
        mistral: MistralVision,
        channel_id: str,
    ):
        self.config = config
        self.db = database
        self.sampler = sampler
        self.scene = scene
        self.cache = cache
        self.tmdb = tmdb
        self.cloudinary = cloudinary
        self.mistral = mistral
        self.channel_id = channel_id

        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._state = "IDLE"
        self._consecutive_failures = 0

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def state(self) -> str:
        return self._state

    def start(self) -> None:
        """Start the autonomous monitoring loop."""
        if self._running:
            return
        self._running = True
        self._state = "ACTIVE"
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info("Worker started for channel %s", self.channel_id)

    def stop(self) -> None:
        """Stop the monitoring loop."""
        self._running = False
        self._state = "IDLE"
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        logger.info("Worker stopped for channel %s", self.channel_id)

    async def _monitor_loop(self) -> None:
        """Main monitoring loop — runs autonomously.

        This is the heart of the autonomous worker.
        It follows the 9-step workflow from the system prompt.
        """
        try:
            while self._running:
                # Get current channel metadata from DB
                channel = self.db.get_channel(self.channel_id)
                if not channel or not channel.is_active:
                    # Channel deactivated — stop worker
                    self._state = "IDLE"
                    break

                # Check if category should be monitored
                if not self.config.is_category_active(channel.category):
                    # Non-active category — long sleep, minimal work
                    self._state = "SLEEPING"
                    await asyncio.sleep(self.config.sleep_after_success)
                    continue

                # STEP 1: Already active (we're here)
                # STEP 2: Capture frame
                self._state = "MONITORING"
                frame = await self._capture_frame(channel)

                if frame is None:
                    # Frame capture failed — retry later
                    self._consecutive_failures += 1
                    self.db.record_error(self.channel_id, "frame_capture_failed")
                    sleep_time = self._get_sleep_time(is_failure=True)
                    await asyncio.sleep(sleep_time)
                    continue

                # STEP 3: Scene change detection
                phash = self.scene.compute_phash(frame)
                scene_changed = self.scene.has_scene_changed(self.channel_id, phash)
                change_magnitude = self.scene.get_change_magnitude(self.channel_id, phash)

                # Always update phash
                self.scene.update(self.channel_id, phash)
                self.db.update_phash(self.channel_id, phash)

                if not scene_changed:
                    # No visual change — sleep
                    self._state = "SLEEPING"
                    interval = self.config.get_worker_interval(channel.category)
                    await asyncio.sleep(interval)
                    continue

                logger.info(
                    "Scene changed on %s (magnitude=%d, hash=%s)",
                    self.channel_id, change_magnitude, phash[:8],
                )

                # STEP 4: AI content identification
                self._state = "ACTIVE"
                detection = await self._identify_content(frame, channel)

                if detection is None:
                    # Failed or low confidence
                    self._consecutive_failures += 1
                    sleep_time = self._get_sleep_time(is_failure=True)
                    await asyncio.sleep(sleep_time)
                    continue

                # STEP 5: Check current metadata
                if channel.current_title == detection.title:
                    # Same movie — no update needed
                    self._consecutive_failures = 0
                    self._state = "SLEEPING"
                    await asyncio.sleep(self.config.sleep_after_success)
                    continue

                # STEP 6: Fetch poster from TMDB
                poster_url, backdrop_url, overview, rating, tmdb_id, cloudinary_id = \
                    await self._fetch_poster(detection, channel)

                # STEP 7: Upload to Cloudinary (if configured)
                final_poster_url = poster_url
                final_cloudinary_id = cloudinary_id
                if self.cloudinary.is_configured() and poster_url:
                    # Delete old poster first
                    if channel.poster_cloudinary_id:
                        await self.cloudinary.delete_poster(channel.poster_cloudinary_id)

                    # Upload new poster
                    cdn_url = await self.cloudinary.upload_poster(
                        poster_url, self.channel_id, detection.title
                    )
                    if cdn_url:
                        final_poster_url = cdn_url
                        final_cloudinary_id = f"{self.config.cloudinary_folder}/{self.channel_id}"

                # STEP 8: Update database
                self.db.update_detection(
                    channel_id=self.channel_id,
                    title=detection.title,
                    content_type=detection.content_type,
                    confidence=detection.confidence,
                    source="vision",
                    year=detection.year,
                    poster=final_poster_url,
                    backdrop=backdrop_url,
                    overview=overview,
                    rating=rating,
                    tmdb_id=tmdb_id,
                    cloudinary_id=final_cloudinary_id,
                    phash=phash,
                )

                # Cache movie for future reuse
                self.db.cache_movie(
                    title=detection.title,
                    year=detection.year,
                    type=detection.content_type,
                    poster_url=final_poster_url,
                    backdrop_url=backdrop_url,
                    overview=overview,
                    rating=rating,
                    tmdb_id=tmdb_id,
                    cloudinary_id=final_cloudinary_id,
                )

                # STEP 9: Sleep mode
                self._consecutive_failures = 0
                self._state = "DETECTED"
                logger.info(
                    "✓ Channel %s: %s (%s) confidence=%.2f → sleeping %ds",
                    self.channel_id,
                    detection.title,
                    detection.year or "?",
                    detection.confidence,
                    self.config.sleep_after_success,
                )
                await asyncio.sleep(self.config.sleep_after_success)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Worker loop crashed for %s: %s", self.channel_id, str(e)[:200])
            self._state = "IDLE"
            self._running = False

    async def _capture_frame(self, channel: ChannelMetadata) -> Optional[Image.Image]:
        """STEP 2: Capture frame from stream using FFmpeg."""
        if not channel.stream_url:
            return None

        frame = await self.sampler.sample(channel.stream_url)
        return frame

    async def _identify_content(
        self,
        frame: Image.Image,
        channel: ChannelMetadata,
    ) -> Optional[Any]:
        """STEP 4: AI content identification via Mistral Vision.

        Only called when scene has changed significantly.
        """
        # Convert frame to base64 for Mistral
        buf = io.BytesIO()
        frame.save(buf, format="JPEG", quality=70)
        frame_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        # Call Mistral Vision
        result = await self.mistral.identify(
            frame_base64=frame_b64,
            channel_name=channel.channel_name,
            category=channel.category,
        )

        return result

    async def _fetch_poster(
        self,
        detection: Any,
        channel: ChannelMetadata,
    ) -> tuple:
        """STEP 6: Fetch poster and metadata from TMDB.

        Also checks movie cache before calling TMDB API.
        """
        poster_url = None
        backdrop_url = None
        overview = None
        rating = None
        tmdb_id = None
        cloudinary_id = None

        # Check movie cache first
        cached = self.db.get_cached_movie(
            detection.title, detection.year, detection.content_type
        )
        if cached and cached.poster_url:
            logger.info("Using cached poster for %s", detection.title)
            return (
                cached.poster_url, cached.backdrop_url,
                cached.overview, cached.rating,
                cached.tmdb_id, cached.cloudinary_id,
            )

        # Fetch from TMDB
        if self.tmdb.is_configured():
            tmdb_data = await self.tmdb.search(
                detection.title,
                detection.content_type,
                detection.year,
            )
            if tmdb_data:
                poster_url = tmdb_data.get("poster")
                backdrop_url = tmdb_data.get("backdrop")
                overview = tmdb_data.get("overview")
                rating = tmdb_data.get("rating")
                tmdb_id = tmdb_data.get("tmdb_id")

        return poster_url, backdrop_url, overview, rating, tmdb_id, cloudinary_id

    def _get_sleep_time(self, is_failure: bool = False) -> float:
        """Calculate sleep time based on state."""
        if is_failure:
            # Exponential backoff on failures
            backoff = min(
                self.config.sleep_after_fail * (2 ** self._consecutive_failures),
                300,  # max 5 minutes
            )
            return backoff

        return self.config.get_worker_interval("default")


class WorkerManager:
    """Manages autonomous workers for all active channels.

    Creates/destroys workers as channels become active/inactive.
    Enforces max_concurrent_workers limit.
    """

    def __init__(
        self,
        config: EngineConfig,
        database: Database,
        sampler: FrameSampler,
        scene: SceneDetector,
        cache: CacheLayer,
        tmdb: TMDBClient,
        cloudinary: CloudinaryClient,
        mistral: MistralVision,
    ):
        self.config = config
        self.db = database
        self.sampler = sampler
        self.scene = scene
        self.cache = cache
        self.tmdb = tmdb
        self.cloudinary = cloudinary
        self.mistral = mistral
        self._workers: Dict[str, AutonomousWorker] = {}

    def activate_channel(
        self,
        channel_id: str,
        channel_name: str = "",
        category: str = "default",
        stream_url: str = "",
    ) -> AutonomousWorker:
        """Activate a channel for monitoring.

        Called when user enters a channel.
        """
        # Register in database
        self.db.register_channel(channel_id, channel_name, category, stream_url)

        # Check if worker already exists
        if channel_id in self._workers:
            existing = self._workers[channel_id]
            if existing.is_running:
                return existing
            # Worker stopped — remove and recreate
            del self._workers[channel_id]

        # Check concurrency limit
        active_count = sum(1 for w in self._workers.values() if w.is_running)
        if active_count >= self.config.max_concurrent_workers:
            # Stop oldest inactive worker to make room
            oldest_id = None
            oldest_time = float("inf")
            for wid, w in self._workers.items():
                if w.is_running and w.state == "SLEEPING":
                    ch = self.db.get_channel(wid)
                    if ch and ch.last_frame_time < oldest_time:
                        oldest_time = ch.last_frame_time
                        oldest_id = wid
            if oldest_id:
                self.deactivate_channel(oldest_id)

        # Create new worker
        worker = AutonomousWorker(
            config=self.config,
            database=self.db,
            sampler=self.sampler,
            scene=self.scene,
            cache=self.cache,
            tmdb=self.tmdb,
            cloudinary=self.cloudinary,
            mistral=self.mistral,
            channel_id=channel_id,
        )
        self._workers[channel_id] = worker
        worker.start()
        return worker

    def deactivate_channel(self, channel_id: str) -> None:
        """Deactivate a channel.

        Called when user leaves a channel.
        """
        if channel_id in self._workers:
            self._workers[channel_id].stop()
            del self._workers[channel_id]

        self.db.deactivate_channel(channel_id)

    def get_worker(self, channel_id: str) -> Optional[AutonomousWorker]:
        """Get the worker for a channel."""
        return self._workers.get(channel_id)

    def stop_all(self) -> None:
        """Stop all workers."""
        for worker in self._workers.values():
            worker.stop()
        self._workers.clear()

    @property
    def active_count(self) -> int:
        return sum(1 for w in self._workers.values() if w.is_running)

    @property
    def total_count(self) -> int:
        return len(self._workers)

    def get_status(self) -> Dict[str, Any]:
        """Get status of all workers."""
        return {
            "totalWorkers": self.total_count,
            "activeWorkers": self.active_count,
            "maxConcurrent": self.config.max_concurrent_workers,
            "workers": {
                wid: {
                    "state": w.state,
                    "running": w.is_running,
                }
                for wid, w in self._workers.items()
            },
        }

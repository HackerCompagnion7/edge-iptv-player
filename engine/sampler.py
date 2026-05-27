"""FFmpeg Frame Sampler for EDGE Vision Engine.

Extracts single frames from HLS/live streams.
Uses subprocess FFmpeg for reliability and format support.
No fragile streaming libraries. Just FFmpeg.
"""

from __future__ import annotations

import io
import asyncio
import subprocess
import logging
from typing import Optional

from PIL import Image

from .config import EngineConfig

logger = logging.getLogger("edge.engine.sampler")


class FrameSampler:
    """Extract frames from live streams using FFmpeg."""

    def __init__(self, config: EngineConfig):
        self.config = config

    async def sample(self, stream_url: str, timeout: Optional[int] = None) -> Optional[Image.Image]:
        """Extract a single frame from a stream URL.

        Args:
            stream_url: HLS or direct stream URL.
            timeout: Override default timeout in seconds.

        Returns:
            PIL Image or None if extraction failed.
        """
        timeout = timeout or self.config.ffmpeg_timeout
        try:
            img = await asyncio.wait_for(
                self._extract(stream_url),
                timeout=timeout + 5,
            )
            return img
        except asyncio.TimeoutError:
            logger.warning("FFmpeg timeout for %s", stream_url[:80])
            return None
        except Exception as e:
            logger.warning("FFmpeg extraction failed: %s", str(e)[:100])
            return None

    async def _extract(self, stream_url: str) -> Optional[Image.Image]:
        """Run FFmpeg subprocess to extract a frame."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self._extract_sync, stream_url
        )

    def _extract_sync(self, stream_url: str) -> Optional[Image.Image]:
        """Synchronous FFmpeg frame extraction."""
        scale = self.config.ffmpeg_scale
        # Build FFmpeg command
        cmd = [
            "ffmpeg",
            "-y",                              # overwrite
            "-threads", "1",                    # single thread
            "-timeout", str(self.config.ffmpeg_timeout * 1000000),  # microseconds
            "-i", stream_url,
            "-vframes", "1",                    # single frame
            "-q:v", str(self.config.ffmpeg_quality),
            "-vf", f"scale=iw*{scale}:ih*{scale}",  # downscale
            "-f", "image2pipe",
            "-vcodec", "png",
            "pipe:1",
        ]

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                timeout=self.config.ffmpeg_timeout + 5,
            )
            if proc.returncode != 0 or len(proc.stdout) == 0:
                stderr = proc.stderr.decode("utf-8", errors="replace")[-200:]
                logger.debug("FFmpeg stderr: %s", stderr)
                return None

            return Image.open(io.BytesIO(proc.stdout)).convert("RGB")

        except subprocess.TimeoutExpired:
            logger.warning("FFmpeg process timeout")
            return None
        except Exception as e:
            logger.warning("FFmpeg error: %s", str(e)[:100])
            return None

    async def sample_base64(
        self, stream_url: str, quality: int = 75
    ) -> Optional[str]:
        """Extract frame and return as base64 JPEG string."""
        import base64

        img = await self.sample(stream_url)
        if img is None:
            return None

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode("ascii")

    def check_available(self) -> bool:
        """Check if FFmpeg is available on the system."""
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False

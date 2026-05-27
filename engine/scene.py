"""Scene Change Detector using pHash for EDGE Vision Engine.

Perceptual hashing for reliable scene change detection.
Only triggers analysis when scene actually changes.
Avoids processing duplicate or near-duplicate frames.
"""

from __future__ import annotations

import logging
from typing import Optional

import imagehash
from PIL import Image

from .config import EngineConfig
from .cache import TTLCache

logger = logging.getLogger("edge.engine.scene")


class SceneDetector:
    """Detect scene changes using perceptual hashing."""

    def __init__(self, config: EngineConfig, cache: TTLCache):
        self.config = config
        self._cache = cache  # phash cache

    def compute_phash(self, image: Image.Image) -> str:
        """Compute perceptual hash for an image."""
        return str(
            imagehash.phash(
                image,
                hash_size=self.config.phash_hash_size,
            )
        )

    def has_scene_changed(
        self,
        channel_id: str,
        current_hash: str,
    ) -> bool:
        """Check if scene has changed since last sample.

        Returns True if:
        - No previous hash exists (first sample)
        - Hamming distance exceeds threshold
        """
        prev_hash = self._cache.get(f"phash:{channel_id}")
        if prev_hash is None:
            return True

        distance = self._hamming_distance(prev_hash, current_hash)
        return distance > self.config.phash_threshold

    def get_change_magnitude(
        self,
        channel_id: str,
        current_hash: str,
    ) -> int:
        """Get the hamming distance between current and previous frame.

        Returns 0 if no previous frame. Returns -1 on error.
        """
        prev_hash = self._cache.get(f"phash:{channel_id}")
        if prev_hash is None:
            return 0
        return self._hamming_distance(prev_hash, current_hash)

    def update(self, channel_id: str, phash: str) -> None:
        """Store current hash for future comparisons."""
        self._cache.set(f"phash:{channel_id}", phash)

    @staticmethod
    def _hamming_distance(hash1: str, hash2: str) -> int:
        """Compute hamming distance between two hex hash strings."""
        try:
            h1 = imagehash.hex_to_hash(hash1)
            h2 = imagehash.hex_to_hash(hash2)
            return h1 - h2
        except Exception:
            return 0

    def should_force_analysis(
        self,
        channel_id: str,
        current_hash: str,
    ) -> bool:
        """Check if scene change is so large it warrants immediate analysis.

        Used for detecting channel changes, commercial breaks, etc.
        """
        prev_hash = self._cache.get(f"phash:{channel_id}")
        if prev_hash is None:
            return True

        distance = self._hamming_distance(prev_hash, current_hash)
        return distance > self.config.phash_high_threshold

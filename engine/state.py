"""Channel State Manager for EDGE Vision Engine.

Tracks per-channel state: last detection, phash, embeddings, OCR history.
Single source of truth for all channel tracking.
"""

from __future__ import annotations

import time
import threading
from typing import Dict, List, Optional

from .models import ChannelState, DetectionResult


class StateManager:
    """Thread-safe channel state manager."""

    def __init__(self):
        self._channels: Dict[str, ChannelState] = {}
        self._lock = threading.RLock()  # Reentrant lock to avoid deadlocks

    def _get_or_create(self, channel_id: str) -> ChannelState:
        """Internal get-or-create (must be called with lock held)."""
        if channel_id not in self._channels:
            self._channels[channel_id] = ChannelState(channel_id=channel_id)
        return self._channels[channel_id]

    def get(self, channel_id: str) -> ChannelState:
        """Get or create channel state."""
        with self._lock:
            return self._get_or_create(channel_id)

    def update(self, channel_id: str, **kwargs) -> ChannelState:
        """Update channel state fields."""
        with self._lock:
            state = self._get_or_create(channel_id)
            for k, v in kwargs.items():
                if hasattr(state, k):
                    setattr(state, k, v)
            return state

    def set_detection(self, channel_id: str, detection: DetectionResult) -> None:
        """Update channel with new detection result."""
        with self._lock:
            state = self._get_or_create(channel_id)
            state.last_detection = detection
            state.detection_count += 1
            state.last_source = detection.source.value
            state.last_frame_time = time.time()

    def set_phash(self, channel_id: str, phash: str) -> None:
        """Update channel phash."""
        with self._lock:
            state = self._get_or_create(channel_id)
            state.last_phash = phash

    def set_scanning(self, channel_id: str, scanning: bool) -> None:
        """Set scanning state."""
        with self._lock:
            state = self._get_or_create(channel_id)
            state.scanning = scanning

    def register(
        self,
        channel_id: str,
        channel_name: str = "",
        category: str = "default",
        stream_url: str = "",
    ) -> ChannelState:
        """Register or update a channel for scanning."""
        with self._lock:
            state = self._get_or_create(channel_id)
            state.channel_name = channel_name
            state.category = category
            state.stream_url = stream_url
            return state

    def remove(self, channel_id: str) -> bool:
        """Remove a channel."""
        with self._lock:
            if channel_id in self._channels:
                del self._channels[channel_id]
                return True
            return False

    def get_all(self) -> Dict[str, ChannelState]:
        """Get all channel states (copy)."""
        with self._lock:
            return dict(self._channels)

    @property
    def count(self) -> int:
        return len(self._channels)

    def active_count(self) -> int:
        """Count channels with recent detections."""
        now = time.time()
        count = 0
        with self._lock:
            for s in self._channels.values():
                if s.last_detection and (now - s.last_frame_time) < 3600:
                    count += 1
        return count

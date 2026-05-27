"""LRU Cache with TTL for EDGE Vision Engine.

Thread-safe, size-bounded cache with automatic expiration.
No Redis. No memcached. In-process. Fast.
Uses collections.OrderedDict for proper LRU eviction.
"""

from __future__ import annotations

import time
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional


class TTLCache:
    """Size-bounded LRU cache with per-entry TTL."""

    def __init__(self, max_size: int = 2000, default_ttl: int = 3600):
        self._store: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._max_size = max_size
        self._default_ttl = default_ttl
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        """Get value if exists and not expired. Returns None otherwise."""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if time.time() - entry["ts"] > entry["ttl"]:
                del self._store[key]
                return None
            # Move to end (most recently used)
            self._store.move_to_end(key)
            return entry["data"]

    def set(self, key: str, data: Any, ttl: Optional[int] = None) -> None:
        """Set value with TTL. Evicts LRU entries when full."""
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
            self._store[key] = {
                "data": data,
                "ts": time.time(),
                "ttl": ttl or self._default_ttl,
            }
            # Evict oldest entries if over capacity
            while len(self._store) > self._max_size:
                self._store.popitem(last=False)

    def delete(self, key: str) -> bool:
        """Delete a key. Returns True if existed."""
        with self._lock:
            if key in self._store:
                del self._store[key]
                return True
            return False

    def clear(self) -> None:
        """Clear all entries."""
        with self._lock:
            self._store.clear()

    @property
    def size(self) -> int:
        return len(self._store)

    def stats(self) -> Dict[str, Any]:
        """Return cache statistics."""
        now = time.time()
        expired = sum(
            1 for e in self._store.values()
            if now - e["ts"] > e["ttl"]
        )
        return {
            "size": len(self._store),
            "max_size": self._max_size,
            "expired_unreaped": expired,
        }


class CacheLayer:
    """Centralized cache layer for all engine components."""

    def __init__(self, config):
        c = config
        self.poster = TTLCache(max_size=c.cache_max_size, default_ttl=c.cache_poster_ttl)
        self.detection = TTLCache(max_size=c.cache_max_size, default_ttl=c.cache_detection_ttl)
        self.embedding = TTLCache(max_size=c.cache_max_size, default_ttl=c.cache_detection_ttl)
        self.ocr = TTLCache(max_size=c.cache_max_size, default_ttl=c.cache_detection_ttl)
        self.genre = TTLCache(max_size=c.cache_max_size, default_ttl=c.cache_genre_ttl)
        self.phash = TTLCache(max_size=c.cache_max_size, default_ttl=c.cache_detection_ttl)

    def stats(self) -> Dict[str, Any]:
        return {
            "poster": self.poster.stats(),
            "detection": self.detection.stats(),
            "embedding": self.embedding.stats(),
            "ocr": self.ocr.stats(),
            "genre": self.genre.stats(),
            "phash": self.phash.stats(),
        }

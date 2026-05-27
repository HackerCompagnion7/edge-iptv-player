"""TMDB API Client for EDGE Vision Engine.

Poster fetching, metadata enrichment, genre-based discovery.
All calls are cached. All calls are async. All calls have timeouts.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

from .config import EngineConfig
from .cache import TTLCache

logger = logging.getLogger("edge.engine.tmdb")

# ── Genre Maps ─────────────────────────────────────────────────
TMDB_GENRE_MAP = {
    "horror": 27, "thriller": 53, "action": 28, "comedy": 35, "drama": 18,
    "romance": 10749, "scifi": 878, "western": 37, "crime": 80,
    "documentary": 99, "animation": 16, "family": 10751, "fantasy": 14,
    "war": 10752, "history": 36, "music_film": 10402, "mystery": 9648,
    "adventure": 12,
}

KEYWORD_GENRE_MAP = {
    "terror": [27], "horror": [27], "adrenalina": [28, 53],
    "comedia": [35], "romance": [10749], "drama": [18],
    "thriller": [53], "western": [37], "crime": [80],
    "action": [28], "classic": [18], "scifi": [878],
    "science": [878], "suspense": [53, 9648], "premiere": [28],
    "cine": [18], "flick": [28], "fear": [27],
    "francais": [], "music": [10402], "kids": [16, 10751],
    "news": [], "sports": [],
}


class TMDBClient:
    """Async TMDB API client with caching."""

    def __init__(self, config: EngineConfig, cache: TTLCache):
        self.config = config
        self._cache = cache
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self.config.tmdb_timeout)
        return self._client

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.tmdb_access_token:
            headers["Authorization"] = f"Bearer {self.config.tmdb_access_token}"
        return headers

    def _params(self, extra: Optional[Dict] = None) -> Dict[str, str]:
        params = {"language": "es"}
        if not self.config.tmdb_access_token and self.config.tmdb_api_key:
            params["api_key"] = self.config.tmdb_api_key
        if extra:
            params.update(extra)
        return params

    async def search(
        self, title: str, content_type: str = "movie", year: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Search TMDB for a title. Returns first result with enrichment."""
        cache_key = f"search:{title}:{year}:{content_type}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        if not self.config.tmdb_api_key and not self.config.tmdb_access_token:
            return None

        endpoint = "search/movie" if content_type == "movie" else "search/tv"
        params = self._params({"query": title})
        if year:
            key = "year" if content_type == "movie" else "first_air_date_year"
            params[key] = year

        try:
            client = await self._get_client()
            resp = await client.get(
                f"{self.config.tmdb_base_url}/{endpoint}",
                headers=self._headers(),
                params=params,
            )
            data = resp.json()
            if data.get("results") and len(data["results"]) > 0:
                result = self._enrich_result(data["results"][0])
                self._cache.set(cache_key, result)
                return result
        except Exception as e:
            logger.debug("TMDB search failed for '%s': %s", title, str(e)[:80])
        return None

    async def discover_by_genre(
        self, genre_ids: List[int], page: int = 1
    ) -> List[Dict[str, Any]]:
        """Discover movies by genre IDs."""
        if not genre_ids:
            return []

        cache_key = f"genre:{','.join(str(g) for g in genre_ids)}:{page}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        if not self.config.tmdb_api_key and not self.config.tmdb_access_token:
            return []

        params = self._params({
            "with_genres": ",".join(str(g) for g in genre_ids),
            "sort_by": "popularity.desc",
            "page": str(page),
            "vote_count.gte": "50",
        })

        try:
            client = await self._get_client()
            resp = await client.get(
                f"{self.config.tmdb_base_url}/discover/movie",
                headers=self._headers(),
                params=params,
            )
            data = resp.json()
            if data.get("results"):
                movies = [self._enrich_result(r) for r in data["results"][:20]]
                self._cache.set(cache_key, movies)
                return movies
        except Exception as e:
            logger.debug("TMDB genre discover failed: %s", str(e)[:80])
        return []

    async def get_trending(
        self, media_type: str = "movie", window: str = "week"
    ) -> List[Dict[str, Any]]:
        """Get trending content."""
        cache_key = f"trending:{media_type}:{window}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        if not self.config.tmdb_api_key and not self.config.tmdb_access_token:
            return []

        try:
            client = await self._get_client()
            resp = await client.get(
                f"{self.config.tmdb_base_url}/trending/{media_type}/{window}",
                headers=self._headers(),
                params=self._params(),
            )
            data = resp.json()
            if data.get("results"):
                items = [self._enrich_result(r) for r in data["results"][:20]]
                self._cache.set(cache_key, items)
                return items
        except Exception as e:
            logger.debug("TMDB trending failed: %s", str(e)[:80])
        return []

    async def detect_from_channel_name(
        self, channel_name: str, category: str = "default"
    ) -> Optional[Dict[str, Any]]:
        """Map channel name keywords to TMDB genres and get candidates."""
        name_lower = channel_name.lower()

        # Step 1: Keyword-based genre detection
        genre_ids = []
        for keyword, ids in KEYWORD_GENRE_MAP.items():
            if keyword in name_lower:
                genre_ids.extend(ids)

        # Step 2: Category fallback
        if not genre_ids and category in KEYWORD_GENRE_MAP:
            genre_ids.extend(KEYWORD_GENRE_MAP[category])

        genre_ids = list(set(genre_ids))
        if not genre_ids:
            return None

        # Step 3: Query TMDB
        movies = await self.discover_by_genre(genre_ids)
        if not movies:
            return None

        # Step 4: Build result with candidates
        top = movies[0]
        candidates = [
            {
                "title": m.get("title", ""),
                "year": m.get("year", ""),
                "poster": m.get("poster"),
                "rating": m.get("rating"),
            }
            for m in movies[:5]
        ]

        genre_labels = [
            label for label, gid in TMDB_GENRE_MAP.items()
            if gid in genre_ids
        ]

        return {
            **top,
            "candidates": candidates,
            "genre_labels": genre_labels,
            "confidence": 0.45,  # Low: genre-based, not exact
            "source": "tmdb_genre",
        }

    def _enrich_result(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Enrich a TMDB result with image URLs."""
        img_base = self.config.tmdb_image_base
        result = {"title": raw.get("title") or raw.get("name", "")}

        if raw.get("poster_path"):
            result["poster"] = f"{img_base}/{self.config.tmdb_poster_size}{raw['poster_path']}"
        if raw.get("backdrop_path"):
            result["backdrop"] = f"{img_base}/{self.config.tmdb_backdrop_size}{raw['backdrop_path']}"
        if raw.get("overview"):
            result["overview"] = raw["overview"]
        if raw.get("vote_average"):
            result["rating"] = raw["vote_average"]
        if raw.get("release_date") or raw.get("first_air_date"):
            result["year"] = (raw.get("release_date") or raw.get("first_air_date", ""))[:4]
        if raw.get("id"):
            result["tmdb_id"] = raw["id"]
        if raw.get("genre_ids"):
            result["genre_ids"] = raw["genre_ids"]
        if raw.get("media_type"):
            result["media_type"] = raw["media_type"]

        return result

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    def is_configured(self) -> bool:
        return bool(self.config.tmdb_api_key or self.config.tmdb_access_token)

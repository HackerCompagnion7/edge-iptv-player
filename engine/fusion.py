"""Detection Fusion Engine for EDGE Vision Engine.

Fuses signals from all detection sources:
  Metadata → OCR → CLIP → Vision → TMDB

Priority-ordered. Confidence-weighted. Cache-aware.
Only runs expensive operations when cheap ones fail.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from PIL import Image

from .config import EngineConfig
from .cache import CacheLayer
from .state import StateManager
from .models import (
    ChannelState,
    ContentType,
    DetectionResult,
    DetectionSource,
)
from .scene import SceneDetector
from .ocr import OCRExtractor
from .embeddings import EmbeddingEngine
from .tmdb_client import TMDBClient

logger = logging.getLogger("edge.engine.fusion")


# ── Content Type Inference ─────────────────────────────────────

CONTENT_KEYWORDS = {
    "movie": ["movie", "film", "pelicula", "cine", "adrenalina", "comedia",
              "terror", "horror", "romance", "drama", "thriller", "western",
              "crime", "classic", "premiere", "action", "cinema", "flick"],
    "series": ["series", "episode", "temporada", "capitulo", "season"],
    "sports": ["sports", "deporte", "futbol", "soccer", "basketball",
               "nba", "nfl", "live", "en vivo", "directo", "equidia"],
    "music": ["music", "musica", "mtv", "deluxe", "rap", "dance", "hits", "concert"],
    "kids": ["kids", "ninos", "infantil", "cartoon", "nickelodeon",
             "disney", "baby", "pokemon"],
    "news": ["news", "noticias", "info", "journal", "bfm", "euronews", "france"],
}


def infer_content_type(text: str) -> ContentType:
    """Infer content type from text (channel name, OCR, etc.)."""
    t = (text or "").lower()
    for ctype, keywords in CONTENT_KEYWORDS.items():
        if any(k in t for k in keywords):
            return ContentType(ctype)
    return ContentType.UNKNOWN


# ── Fusion Engine ──────────────────────────────────────────────

class FusionEngine:
    """Orchestrates the full detection pipeline."""

    def __init__(
        self,
        config: EngineConfig,
        cache: CacheLayer,
        state: StateManager,
        scene: SceneDetector,
        ocr: OCRExtractor,
        clip: EmbeddingEngine,
        tmdb: TMDBClient,
    ):
        self.config = config
        self.cache = cache
        self.state = state
        self.scene = scene
        self.ocr = ocr
        self.clip = clip
        self.tmdb = tmdb

    async def analyze(
        self,
        channel_id: str,
        category: str = "default",
        frame_image: Optional[Image.Image] = None,
        frame_base64: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[DetectionResult]:
        """Run full detection pipeline for a channel.

        Pipeline order (cheapest first):
          1. Metadata (free, instant)
          2. OCR (fast, local)
          3. CLIP matching (local, moderate)
          4. TMDB genre (free API call)
          5. Vision AI (expensive, last resort)
        """
        channel = self.state.get(channel_id)
        channel.category = category

        # ── Scene Change Detection ───────────────────────────
        phash = ""
        scene_changed = True

        if frame_image is not None:
            phash = self.scene.compute_phash(frame_image)
            scene_changed = self.scene.has_scene_changed(channel_id, phash)
            change_magnitude = self.scene.get_change_magnitude(channel_id, phash)

            # Update phash
            self.scene.update(channel_id, phash)

            # If no scene change and we have a recent detection, return it
            if not scene_changed and channel.last_detection:
                if channel.last_detection.confidence >= self.config.confidence_accept:
                    channel.last_detection.scene_changed = False
                    return channel.last_detection

        # ── Check detection cache ────────────────────────────
        cache_key = f"detect:{channel_id}"
        cached = self.cache.detection.get(cache_key)
        if cached and not scene_changed:
            return cached

        # ── Run Pipeline ─────────────────────────────────────
        best_detection: Optional[DetectionResult] = None

        # 1. Metadata detection (free, instant)
        if metadata and metadata.get("title"):
            meta_result = self._detect_metadata(metadata, channel_id)
            if meta_result:
                best_detection = meta_result

        # 2. OCR detection (fast, local, cheap)
        if frame_image is not None and self.ocr.is_available():
            ocr_result = self._detect_ocr(frame_image, channel_id, category)
            if ocr_result and (
                best_detection is None
                or ocr_result.confidence > best_detection.confidence
            ):
                best_detection = ocr_result

        # 3. TMDB genre detection (free API call)
        if (
            best_detection is None
            or best_detection.confidence < self.config.confidence_accept
        ) and (channel.channel_name or category):
            tmdb_result = await self._detect_tmdb_genre(
                channel.channel_name or metadata.get("title", "") if metadata else "",
                category,
                channel_id,
            )
            if tmdb_result and (
                best_detection is None
                or tmdb_result.confidence > best_detection.confidence
            ):
                best_detection = tmdb_result

        # 4. CLIP matching (local, moderate cost)
        if (
            frame_image is not None
            and self.clip.is_available()
            and (best_detection is None or best_detection.confidence < self.config.confidence_clip)
        ):
            clip_result = self._detect_clip(
                frame_image, channel_id, category, best_detection
            )
            if clip_result and (
                best_detection is None
                or clip_result.confidence > best_detection.confidence
            ):
                best_detection = clip_result

        # 5. Vision AI (expensive, last resort)
        if (
            frame_base64
            and best_detection is None
            or (best_detection and best_detection.confidence < self.config.confidence_vision)
        ):
            vision_result = await self._detect_vision(
                frame_base64, channel.channel_name, category, channel_id
            )
            if vision_result and (
                best_detection is None
                or vision_result.confidence > best_detection.confidence
            ):
                best_detection = vision_result

        # ── Finalize ─────────────────────────────────────────
        if best_detection:
            best_detection.scene_changed = scene_changed
            best_detection.channel_id = channel_id
            best_detection.timestamp = time.time()

            # Enrich with TMDB poster/metadata
            if best_detection.confidence >= self.config.confidence_poster and best_detection.title:
                await self._enrich_tmdb(best_detection)

            # Cache and update state
            self.cache.detection.set(cache_key, best_detection)
            self.state.set_detection(channel_id, best_detection)

        return best_detection

    # ── Detection Methods ──────────────────────────────────────

    def _detect_metadata(
        self, metadata: Dict[str, Any], channel_id: str
    ) -> Optional[DetectionResult]:
        """Detect from metadata (channel name, genre tags)."""
        title = metadata.get("title", "")
        if not title or len(title) < 2:
            return None

        genre = metadata.get("genre", [])
        content_type = infer_content_type(title + " " + " ".join(genre))

        return DetectionResult(
            title=title,
            content_type=content_type,
            confidence=self.config.confidence_metadata,
            source=DetectionSource.METADATA,
            genre=genre,
            year=metadata.get("year"),
            channel_id=channel_id,
        )

    def _detect_ocr(
        self, image: Image.Image, channel_id: str, category: str
    ) -> Optional[DetectionResult]:
        """Detect content from OCR text."""
        texts = self.ocr.extract_texts(image)
        if not texts:
            return None

        # Store OCR results in channel state
        self.state.update(channel_id, last_ocr_texts=texts)

        # Try to identify a title from OCR text
        # Heuristic: longer, high-confidence text at top of screen
        title_candidates = self.ocr.extract_title_candidates(image)

        if title_candidates:
            best_title = title_candidates[0]
            content_type = infer_content_type(
                " ".join(texts) + " " + category
            )

            return DetectionResult(
                title=best_title,
                content_type=content_type,
                confidence=self.config.confidence_ocr,
                source=DetectionSource.OCR,
                ocr_texts=texts,
                alternatives=[
                    {"title": t, "confidence": 0.5}
                    for t in title_candidates[1:]
                ],
                channel_id=channel_id,
            )

        return None

    def _detect_clip(
        self,
        image: Image.Image,
        channel_id: str,
        category: str,
        current_best: Optional[DetectionResult],
    ) -> Optional[DetectionResult]:
        """Use CLIP embeddings for content matching."""
        # Compute image embedding
        img_embedding = self.clip.compute_image_embedding(image)
        if img_embedding is None:
            return None

        # Store embedding in channel state
        self.state.update(channel_id, last_embedding=img_embedding)

        # If we have candidates from TMDB genre, try CLIP matching
        if current_best and current_best.alternatives:
            candidates = [current_best.title] + [
                a.get("title", "") for a in current_best.alternatives
            ]
        else:
            # Generic candidates based on category
            candidates = self._category_candidates(category)

        if not candidates:
            return None

        # Match against candidate titles
        matches = self.clip.match_title(img_embedding, candidates)
        if not matches:
            return None

        best_match_title, best_sim = matches[0]
        if best_sim >= self.config.clip_candidate_threshold:
            content_type = infer_content_type(
                best_match_title + " " + category
            )

            return DetectionResult(
                title=best_match_title,
                content_type=content_type,
                confidence=min(best_sim, 0.90),
                source=DetectionSource.CLIP,
                alternatives=[
                    {"title": t, "confidence": round(s, 3), "source": "clip"}
                    for t, s in matches[1:4]
                    if s >= self.config.clip_candidate_threshold
                ],
                channel_id=channel_id,
            )

        return None

    async def _detect_tmdb_genre(
        self, channel_name: str, category: str, channel_id: str
    ) -> Optional[DetectionResult]:
        """Detect from TMDB genre matching."""
        result = await self.tmdb.detect_from_channel_name(channel_name, category)
        if not result:
            return None

        return DetectionResult(
            title=result.get("title", ""),
            content_type=infer_content_type(channel_name + " " + category),
            confidence=result.get("confidence", 0.45),
            source=DetectionSource.TMDB_GENRE,
            year=result.get("year"),
            genre=result.get("genre_labels", []),
            poster=result.get("poster"),
            backdrop=result.get("backdrop"),
            overview=result.get("overview"),
            rating=result.get("rating"),
            tmdb_id=result.get("tmdb_id"),
            alternatives=[
                {"title": c.get("title", ""), "confidence": 0.4}
                for c in result.get("candidates", [])[:5]
            ],
            channel_id=channel_id,
        )

    async def _detect_vision(
        self, frame_b64: str, channel_name: str, category: str, channel_id: str
    ) -> Optional[DetectionResult]:
        """Use Mistral Pixtral for vision-based identification."""
        if not self.config.mistral_api_key or not frame_b64:
            return None

        prompt = (
            f'Eres EDGE Vision, experto identificador de contenido TV. '
            f'Canal: "{channel_name}" ({category}). '
            f"Analiza esta captura con MAXIMA ATENCION. "
            f'Responde SOLO JSON: {{"title":"titulo","type":"movie|series|sports|music|unknown",'
            f'"confidence":0.0-1.0,"year":"ano","genre":["g1"],'
            f'"alternatives":[{{"title":"...","confidence":0.0}}]}} '
            f"REGLAS: SIEMPRE intenta. NUNCA digas no puedes. "
            f"Busca actores, texto, logos, efectos. "
            f"Si sci-fi/terror con naves: Alien, Aliens, Prometheus, The Thing, Event Horizon, Life, Species, Predator."
        )

        try:
            async with httpx.AsyncClient(timeout=self.config.mistral_timeout) as client:
                resp = await client.post(
                    "https://api.mistral.ai/v1/chat/completions",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self.config.mistral_api_key}",
                    },
                    json={
                        "model": self.config.mistral_model,
                        "messages": [
                            {"role": "system", "content": prompt},
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": "Identifica el contenido de esta captura de pantalla."},
                                    {
                                        "type": "image_url",
                                        "image_url": f"data:image/jpeg;base64,{frame_b64}",
                                    },
                                ],
                            },
                        ],
                        "temperature": 0.1,
                        "max_tokens": 400,
                    },
                )
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

                # Parse JSON response
                import json, re
                json_match = re.search(r"\{[\s\S]*?\}", content)
                if json_match:
                    result = json.loads(json_match.group())
                    if result.get("confidence", 0) >= self.config.confidence_vision:
                        return DetectionResult(
                            title=result.get("title", ""),
                            content_type=ContentType(result.get("type", "unknown")),
                            confidence=float(result.get("confidence", 0.5)),
                            source=DetectionSource.VISION,
                            year=result.get("year"),
                            genre=result.get("genre", []),
                            alternatives=result.get("alternatives", []),
                            channel_id=channel_id,
                        )

        except Exception as e:
            logger.warning("Vision detection failed: %s", str(e)[:100])

        return None

    async def _enrich_tmdb(self, detection: DetectionResult) -> None:
        """Enrich detection result with TMDB data."""
        tmdb_data = await self.tmdb.search(
            detection.title,
            detection.content_type.value,
            detection.year,
        )
        if tmdb_data:
            if tmdb_data.get("poster") and not detection.poster:
                detection.poster = tmdb_data["poster"]
            if tmdb_data.get("backdrop") and not detection.backdrop:
                detection.backdrop = tmdb_data["backdrop"]
            if tmdb_data.get("overview") and not detection.overview:
                detection.overview = tmdb_data["overview"]
            if tmdb_data.get("rating") and not detection.rating:
                detection.rating = tmdb_data["rating"]
            if tmdb_data.get("year") and not detection.year:
                detection.year = tmdb_data["year"]
            if tmdb_data.get("tmdb_id") and not detection.tmdb_id:
                detection.tmdb_id = tmdb_data["tmdb_id"]

    @staticmethod
    def _category_candidates(category: str) -> List[str]:
        """Generate generic candidate titles for CLIP matching."""
        candidates = {
            "movies": [
                "action movie", "horror movie", "comedy film",
                "drama movie", "thriller film", "science fiction movie",
                "romantic comedy", "western film",
            ],
            "sports": [
                "football match", "soccer game", "basketball game",
                "sports news", "live sports event",
            ],
            "music": [
                "music video", "concert live", "music show",
                "pop music", "rock concert",
            ],
            "news": [
                "news broadcast", "breaking news", "weather report",
                "news interview", "live news",
            ],
            "kids": [
                "cartoon animation", "kids show", "animated movie",
                "children program", "anime",
            ],
        }
        return candidates.get(category, candidates["movies"])

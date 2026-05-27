"""Mistral Vision Client for EDGE Vision Engine.

Sends frames to Mistral Pixtral for content identification.
Returns structured detection results with confidence scoring.
Only called when scene changes — never on duplicate frames.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional
from dataclasses import dataclass

import httpx

from .config import EngineConfig

logger = logging.getLogger("edge.engine.mistral")


@dataclass
class VisionResult:
    """Structured result from Mistral Vision identification."""
    title: str = ""
    year: Optional[str] = None
    content_type: str = "unknown"
    confidence: float = 0.0
    genre: List[str] = None
    alternatives: List[Dict[str, Any]] = None
    scene_context: str = ""

    def __post_init__(self):
        if self.genre is None:
            self.genre = []
        if self.alternatives is None:
            self.alternatives = []

    @property
    def is_valid(self) -> bool:
        """Check if this detection is valid (title + minimum confidence)."""
        return bool(self.title) and self.confidence >= 0.5

    def to_dict(self) -> Dict[str, Any]:
        return {
            "title": self.title,
            "year": self.year,
            "type": self.content_type,
            "confidence": round(self.confidence, 3),
            "genre": self.genre,
            "alternatives": self.alternatives,
            "sceneContext": self.scene_context,
        }


# ── Content Type Inference ─────────────────────────────────────

CONTENT_KEYWORDS = {
    "movie": [
        "movie", "film", "pelicula", "cine", "adrenalina", "comedia",
        "terror", "horror", "romance", "drama", "thriller", "western",
        "crime", "classic", "premiere", "action", "cinema", "flick",
        "science fiction", "sci-fi", "fantasy",
    ],
    "series": ["series", "episode", "temporada", "capitulo", "season", "show"],
    "sports": ["sports", "deporte", "futbol", "soccer", "basketball", "nba", "nfl", "live"],
    "music": ["music", "musica", "mtv", "concert", "video musical"],
    "kids": ["kids", "ninos", "infantil", "cartoon", "animacion", "disney", "anime"],
    "news": ["news", "noticias", "info", "journal", "report"],
}


def infer_content_type(text: str) -> str:
    """Infer content type from text."""
    t = (text or "").lower()
    for ctype, keywords in CONTENT_KEYWORDS.items():
        if any(k in t for k in keywords):
            return ctype
    return "unknown"


class MistralVision:
    """Mistral Pixtral client for content identification.

    CRITICAL RULES:
    - Only called when scene has changed
    - Only for active categories (movie, kids)
    - Confidence must be >= 0.75 to accept
    - Never called on duplicate/near-duplicate frames
    """

    def __init__(self, config: EngineConfig):
        self.config = config
        self._call_count = 0
        self._daily_cost = 0.0

    @property
    def is_configured(self) -> bool:
        return self.config.mistral_configured

    @property
    def daily_cost(self) -> float:
        return self._daily_cost

    @property
    def can_call(self) -> bool:
        """Check if we can make another vision call (budget)."""
        return self.is_configured and self._daily_cost < self.config.daily_budget

    async def identify(
        self,
        frame_base64: str,
        channel_name: str = "",
        category: str = "default",
    ) -> Optional[VisionResult]:
        """Send frame to Mistral Vision for content identification.

        This is the ONLY method that calls Mistral.
        It should only be called when:
        1. Scene has changed significantly
        2. Current metadata is stale or missing
        3. Budget allows

        Args:
            frame_base64: JPEG frame as base64 string.
            channel_name: Name of the channel (for context).
            category: Channel category (for context).

        Returns:
            VisionResult or None on failure/low confidence.
        """
        if not self.is_configured or not frame_base64:
            return None

        if not self.can_call:
            logger.warning("Daily vision budget exhausted: $%.4f", self._daily_cost)
            return None

        # Build focused identification prompt
        prompt = self._build_prompt(channel_name, category)

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
                                    {
                                        "type": "text",
                                        "text": (
                                            f"Identifica el contenido que esta reproduciendose "
                                            f"en este canal: {channel_name} ({category}). "
                                            f"Responde SOLO con JSON valido."
                                        ),
                                    },
                                    {
                                        "type": "image_url",
                                        "image_url": f"data:image/jpeg;base64,{frame_base64}",
                                    },
                                ],
                            },
                        ],
                        "temperature": 0.1,
                        "max_tokens": 300,
                    },
                )

                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

                # Record cost
                self._call_count += 1
                self._daily_cost += self.config.cost_vision_call

                if not content:
                    logger.warning("Mistral returned empty content for %s", channel_name)
                    return None

                # Parse JSON from response
                result = self._parse_response(content)
                if result and result.confidence >= self.config.mistral_confidence_min:
                    logger.info(
                        "Vision ID: %s (%s) confidence=%.2f",
                        result.title, result.year or "?", result.confidence,
                    )
                    return result
                else:
                    conf = result.confidence if result else 0
                    logger.info(
                        "Vision ID below threshold: confidence=%.2f < %.2f",
                        conf, self.config.mistral_confidence_min,
                    )
                    return None

        except httpx.TimeoutException:
            logger.warning("Mistral timeout for %s", channel_name)
            return None
        except Exception as e:
            logger.warning("Mistral error: %s", str(e)[:100])
            return None

    def _build_prompt(self, channel_name: str, category: str) -> str:
        """Build system prompt for content identification.

        CRITICAL: This prompt is focused on IDENTIFICATION, not chat.
        The AI worker is NOT a chatbot — it's a metadata engine.
        """
        return (
            "Eres EDGE Vision AI Worker — un motor de identificacion de contenido "
            "audiovisual para television en vivo. Tu UNICA funcion es identificar "
            "que pelicula, serie o programa esta reproduciendose en la captura de pantalla.\n\n"

            "REGLAS:\n"
            "- Responde SOLO con JSON valido, sin texto adicional\n"
            "- Si identificas el contenido, confidence debe ser >= 0.75\n"
            "- Si NO estas seguro, pon confidence < 0.75 y agrega alternatives\n"
            "- Busca ACTORES reconocibles como pista principal\n"
            "- Busca TEXTO en pantalla: titulos, creditos, logos, subtitulos\n"
            "- Busca escenas iconicas, efectos especiales, estilo visual\n"
            "- NUNCA digas que no puedes identificar — siempre intenta\n\n"

            "FORMATO JSON OBLIGATORIO:\n"
            '{"title":"titulo exacto","year":"ano","type":"movie|series|kids|sports|music|unknown",'
            '"confidence":0.0-1.0,"genre":["genero1"],"alternatives":['
            '{"title":"...","confidence":0.0}],"sceneContext":"descripcion breve"}\n\n'

            f"CANAL: {channel_name} (categoria: {category})"
        )

    def _parse_response(self, content: str) -> Optional[VisionResult]:
        """Parse Mistral's JSON response into a VisionResult."""
        try:
            # Extract JSON from response (might have markdown wrapping)
            json_match = re.search(r'\{[\s\S]*?\}', content)
            if not json_match:
                return None

            data = json.loads(json_match.group())

            title = data.get("title", "").strip()
            if not title:
                return None

            year = str(data.get("year", "")) if data.get("year") else None
            # Clean year to 4 digits
            if year and len(year) > 4:
                year = year[:4]

            confidence = float(data.get("confidence", 0))
            # Clamp to [0, 1]
            confidence = max(0.0, min(1.0, confidence))

            content_type = data.get("type", "unknown")
            if content_type not in ("movie", "series", "kids", "sports", "music", "unknown"):
                content_type = infer_content_type(title + " " + content_type)

            return VisionResult(
                title=title,
                year=year,
                content_type=content_type,
                confidence=confidence,
                genre=data.get("genre", []),
                alternatives=data.get("alternatives", []),
                scene_context=data.get("sceneContext", ""),
            )

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning("Failed to parse Mistral response: %s", str(e)[:80])
            return None

    async def chat(
        self,
        question: str,
        frame_base64: Optional[str] = None,
        channel_name: str = "",
        category: str = "default",
    ) -> Optional[Dict[str, Any]]:
        """Chat endpoint for user-initiated questions.

        This is SEPARATE from the autonomous identification.
        Only called when user explicitly asks a question.
        """
        if not self.is_configured:
            return None

        is_content_query = any(
            k in question.lower()
            for k in [
                "que pelicula", "que esta", "que dan", "que ponen",
                "what movie", "what show", "what playing", "que serie",
                "identifica", "detecta", "que ves", "what do you see",
            ]
        )

        system_prompt = (
            f"Eres EDGE Vision, asistente de EDGE TV IPTV. "
            f"Canal: {channel_name} ({category}). "
            f"NUNCA digas 'no puedo'. SIEMPRE intenta identificar. "
            f"Busca actores, texto, logos, efectos. "
            f"Responde conciso, maximo 3 lineas."
        )

        try:
            messages = [{"role": "system", "content": system_prompt}]

            if frame_base64 and is_content_query:
                user_content = [
                    {"type": "text", "text": question},
                    {
                        "type": "image_url",
                        "image_url": f"data:image/jpeg;base64,{frame_base64}",
                    },
                ]
            else:
                user_content = question

            messages.append({"role": "user", "content": user_content})

            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    "https://api.mistral.ai/v1/chat/completions",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self.config.mistral_api_key}",
                    },
                    json={
                        "model": self.config.mistral_model if (frame_base64 and is_content_query) else "mistral-small",
                        "messages": messages,
                        "temperature": 0.3,
                        "max_tokens": 300,
                    },
                )
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content:
                    self._daily_cost += self.config.cost_vision_call
                    return {"response": content, "source": "vision" if (frame_base64 and is_content_query) else "text_chat"}
                return None

        except Exception as e:
            logger.warning("Chat error: %s", str(e)[:80])
            return None

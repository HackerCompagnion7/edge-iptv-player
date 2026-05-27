"""OpenCLIP Visual Embeddings for EDGE Vision Engine.

Computes visual embeddings for scene similarity, poster matching,
and intro/outro detection. Model loaded once, reused forever.
"""

from __future__ import annotations

import logging
import time
from typing import List, Optional, Tuple

import torch
import numpy as np
from PIL import Image

from .config import EngineConfig
from .cache import TTLCache
from .models import EmbeddingResult

logger = logging.getLogger("edge.engine.clip")


class EmbeddingEngine:
    """OpenCLIP visual embedding computation."""

    def __init__(self, config: EngineConfig, cache: TTLCache):
        self.config = config
        self._cache = cache
        self._model = None
        self._preprocess = None
        self._tokenizer = None
        self._initialized = False

    def _ensure_initialized(self) -> bool:
        """Lazy-load OpenCLIP model."""
        if self._initialized:
            return self._model is not None

        try:
            import open_clip

            model, _, preprocess = open_clip.create_model_and_transforms(
                self.config.clip_model,
                pretrained=self.config.clip_pretrained,
            )
            tokenizer = open_clip.get_tokenizer(self.config.clip_model)

            self._model = model.eval()
            self._preprocess = preprocess
            self._tokenizer = tokenizer
            self._initialized = True
            logger.info(
                "OpenCLIP initialized: %s/%s",
                self.config.clip_model,
                self.config.clip_pretrained,
            )
            return True
        except Exception as e:
            logger.error("OpenCLIP init failed: %s", str(e)[:200])
            self._initialized = True
            self._model = None
            # Try SigLIP as fallback
            try:
                import open_clip
                model, _, preprocess = open_clip.create_model_and_transforms(
                    "ViT-B-16-SigLIP",
                    pretrained="webli",
                )
                tokenizer = open_clip.get_tokenizer("ViT-B-16-SigLIP")
                self._model = model.eval()
                self._preprocess = preprocess
                self._tokenizer = tokenizer
                logger.info("OpenCLIP fallback: SigLIP initialized")
                return True
            except Exception as e2:
                logger.error("SigLIP fallback also failed: %s", str(e2)[:200])
                return False

    def compute_image_embedding(self, image: Image.Image) -> Optional[List[float]]:
        """Compute embedding for a PIL Image."""
        if not self._ensure_initialized():
            return None

        try:
            with torch.no_grad():
                image_input = self._preprocess(image).unsqueeze(0)
                embedding = self._model.encode_image(image_input)
                embedding = embedding / embedding.norm(dim=-1, keepdim=True)
                return embedding.squeeze().tolist()
        except Exception as e:
            logger.warning("Image embedding failed: %s", str(e)[:100])
            return None

    def compute_text_embedding(self, text: str) -> Optional[List[float]]:
        """Compute embedding for a text string."""
        if not self._ensure_initialized():
            return None

        try:
            with torch.no_grad():
                text_input = self._tokenizer([text])
                embedding = self._model.encode_text(text_input)
                embedding = embedding / embedding.norm(dim=-1, keepdim=True)
                return embedding.squeeze().tolist()
        except Exception as e:
            logger.warning("Text embedding failed: %s", str(e)[:100])
            return None

    def compute_image_embedding_cached(
        self, image: Image.Image, cache_key: str
    ) -> Optional[List[float]]:
        """Compute image embedding with cache."""
        cached = self._cache.get(f"emb:{cache_key}")
        if cached is not None:
            return cached

        embedding = self.compute_image_embedding(image)
        if embedding is not None:
            self._cache.set(f"emb:{cache_key}", embedding)

        return embedding

    @staticmethod
    def cosine_similarity(a: List[float], b: List[float]) -> float:
        """Compute cosine similarity between two embeddings."""
        a_np = np.array(a)
        b_np = np.array(b)
        norm_a = np.linalg.norm(a_np)
        norm_b = np.linalg.norm(b_np)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a_np, b_np) / (norm_a * norm_b))

    def match_title(
        self,
        image_embedding: List[float],
        candidate_titles: List[str],
    ) -> List[Tuple[str, float]]:
        """Match image embedding against candidate titles.

        Returns list of (title, similarity) sorted by similarity descending.
        """
        results = []
        for title in candidate_titles:
            text_emb = self.compute_text_embedding(title)
            if text_emb is not None:
                sim = self.cosine_similarity(image_embedding, text_emb)
                results.append((title, sim))

        results.sort(key=lambda x: x[1], reverse=True)
        return results

    def match_posters(
        self,
        image_embedding: List[float],
        poster_embeddings: List[Tuple[str, List[float]]],  # (url, embedding)
        top_k: int = 3,
    ) -> List[Tuple[str, float]]:
        """Match image embedding against poster embeddings.

        Returns top-k (poster_url, similarity) pairs.
        """
        results = []
        for url, p_emb in poster_embeddings:
            sim = self.cosine_similarity(image_embedding, p_emb)
            results.append((url, sim))

        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    def is_available(self) -> bool:
        """Check if OpenCLIP is available."""
        return self._ensure_initialized()

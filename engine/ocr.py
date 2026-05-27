"""PaddleOCR Text Extraction for EDGE Vision Engine.

Extracts text from video frames: titles, scoreboards, subtitles, overlays.
Runs ONCE per scene change. Results are cached aggressively.
"""

from __future__ import annotations

import logging
import numpy as np
from typing import List, Optional

from PIL import Image

from .config import EngineConfig
from .cache import TTLCache
from .models import OCRResult

logger = logging.getLogger("edge.engine.ocr")


class OCRExtractor:
    """PaddleOCR-based text extraction."""

    def __init__(self, config: EngineConfig, cache: TTLCache):
        self.config = config
        self._cache = cache
        self._ocr = None
        self._initialized = False

    def _ensure_initialized(self) -> bool:
        """Lazy-initialize PaddleOCR (heavy, do on first use)."""
        if self._initialized:
            return self._ocr is not None

        try:
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                lang=self.config.ocr_lang,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=True,
            )
            self._initialized = True
            logger.info("PaddleOCR initialized (lang=%s)", self.config.ocr_lang)
            return True
        except Exception as e:
            logger.error("PaddleOCR init failed: %s", str(e)[:200])
            self._initialized = True
            self._ocr = None
            return False

    def extract(self, image: Image.Image) -> List[OCRResult]:
        """Extract text from a PIL Image.

        Returns list of OCR results with confidence filtering.
        """
        if not self._ensure_initialized():
            return []

        # Check cache using image hash
        img_hash = self._image_hash(image)
        cached = self._cache.get(f"ocr:{img_hash}")
        if cached is not None:
            return cached

        try:
            img_array = np.array(image)
            results = self._ocr.ocr(img_array, cls=True)

            ocr_results = []
            if results:
                # PaddleOCR v3+ returns list of pages
                for page in results:
                    if page is None:
                        continue
                    for line in page:
                        # Handle both v2 and v3 output formats
                        if isinstance(line, dict):
                            text = line.get("text", line.get("rec_texts", [""])[0] if isinstance(line.get("rec_texts"), list) else "")
                            confidence = line.get("score", line.get("rec_scores", [0])[0] if isinstance(line.get("rec_scores"), list) else 0)
                            bbox = None
                        elif isinstance(line, (list, tuple)) and len(line) >= 2:
                            # v2 format: [bbox, (text, confidence)]
                            bbox_data = line[0]
                            text_info = line[1] if isinstance(line[1], (list, tuple)) else (line[1], 0.9)
                            text = text_info[0] if isinstance(text_info, (list, tuple)) else str(text_info)
                            confidence = text_info[1] if isinstance(text_info, (list, tuple)) and len(text_info) > 1 else 0.9
                            bbox = [float(x) for point in bbox_data for x in point] if bbox_data else None
                        else:
                            continue

                        if isinstance(confidence, (list, np.ndarray)):
                            confidence = float(confidence[0]) if len(confidence) > 0 else 0.5
                        confidence = float(confidence)

                        if confidence >= self.config.ocr_confidence_min and len(str(text).strip()) >= 2:
                            ocr_results.append(
                                OCRResult(
                                    text=str(text).strip(),
                                    confidence=confidence,
                                    bbox=bbox,
                                )
                            )

            # Cache results
            self._cache.set(f"ocr:{img_hash}", ocr_results)
            return ocr_results

        except Exception as e:
            logger.warning("OCR extraction failed: %s", str(e)[:100])
            return []

    def extract_texts(self, image: Image.Image) -> List[str]:
        """Extract just the text strings from an image.

        Convenience method for downstream consumers.
        """
        results = self.extract(image)
        return [r.text for r in results]

    def extract_title_candidates(self, image: Image.Image) -> List[str]:
        """Extract text that looks like titles (larger text, top of screen).

        Heuristic: longer text with high confidence is more likely a title.
        """
        results = self.extract(image)
        # Sort by confidence descending
        sorted_results = sorted(results, key=lambda r: r.confidence, reverse=True)
        # Take top candidates (high confidence + reasonable length)
        candidates = []
        for r in sorted_results:
            if len(r.text) >= 3 and r.confidence >= 0.6:
                candidates.append(r.text)
            if len(candidates) >= 5:
                break
        return candidates

    @staticmethod
    def _image_hash(image: Image.Image) -> str:
        """Quick hash for cache key."""
        import hashlib

        buf = image.tobytes()
        return hashlib.md5(buf[:4096]).hexdigest()[:16]

    def is_available(self) -> bool:
        """Check if PaddleOCR is available."""
        return self._ensure_initialized()

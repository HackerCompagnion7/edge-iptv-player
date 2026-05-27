"""Cloudinary Client for EDGE Vision Engine.

Uploads validated poster images. Deletes old posters to avoid accumulation.
NEVER uploads frames, temporary images, or raw captures.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger("edge.engine.cloudinary")


class CloudinaryClient:
    """Cloudinary poster storage client.

    Only handles FINAL validated poster images.
    All temporary frames are disposable.
    """

    def __init__(self, config):
        self._config = config
        self._client = None

    def _ensure_initialized(self) -> bool:
        """Lazy-initialize Cloudinary SDK."""
        if self._client is not None:
            return True

        if not self._config.cloudinary_configured:
            self._client = None
            return False

        try:
            import cloudinary
            import cloudinary.uploader
            import cloudinary.api

            cloudinary.config(
                cloud_name=self._config.cloudinary_cloud_name,
                api_key=self._config.cloudinary_api_key,
                api_secret=self._config.cloudinary_api_secret,
                secure=True,
            )
            self._client = cloudinary
            logger.info("Cloudinary initialized: %s", self._config.cloudinary_cloud_name)
            return True
        except ImportError:
            logger.warning("Cloudinary SDK not installed. pip install cloudinary")
            self._client = None
            return False
        except Exception as e:
            logger.error("Cloudinary init failed: %s", str(e)[:100])
            self._client = None
            return False

    async def upload_poster(
        self,
        image_url: str,
        channel_id: str,
        title: str,
    ) -> Optional[str]:
        """Upload a poster image to Cloudinary.

        Args:
            image_url: URL of the poster image (from TMDB).
            channel_id: Channel ID for naming.
            title: Movie title for tagging.

        Returns:
            Cloudinary URL or None on failure.
        """
        if not self._ensure_initialized():
            return None

        try:
            import cloudinary.uploader

            public_id = f"{self._config.cloudinary_folder}/{channel_id}"

            result = cloudinary.uploader.upload(
                image_url,
                public_id=public_id,
                overwrite=True,
                tags=["edge-tv", "poster", f"channel-{channel_id}"],
                context={"title": title, "channel": channel_id},
                transformation=[
                    {"width": 500, "height": 750, "crop": "fill",
                     "quality": "auto", "fetch_format": "auto"},
                ],
            )

            url = result.get("secure_url", "")
            if url:
                logger.info("Uploaded poster for %s: %s", channel_id, url[:60])
            return url

        except Exception as e:
            logger.warning("Cloudinary upload failed for %s: %s", channel_id, str(e)[:100])
            return None

    async def delete_poster(self, public_id: str) -> bool:
        """Delete a previous poster from Cloudinary.

        Called before uploading a new poster to avoid accumulation.
        """
        if not self._ensure_initialized():
            return False

        try:
            import cloudinary.uploader

            result = cloudinary.uploader.destroy(public_id)
            return result.get("result") == "ok"
        except Exception as e:
            logger.warning("Cloudinary delete failed: %s", str(e)[:80])
            return False

    def is_configured(self) -> bool:
        """Check if Cloudinary is configured."""
        return self._config.cloudinary_configured

"""EDGE Vision Engine - Entry point for `python -m engine`."""

import uvicorn
from .config import EngineConfig


def main():
    config = EngineConfig.from_env()
    uvicorn.run(
        "engine.main:app",
        host=config.host,
        port=config.port,
        workers=1,
        log_level="info",
    )


if __name__ == "__main__":
    main()

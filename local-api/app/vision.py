"""Bounded image preprocessing for local vision-language inference."""

from __future__ import annotations

import math
import warnings
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


VISION_MAX_LONG_EDGE = 1280
VISION_MAX_PIXELS = 1280 * 28 * 28
VISION_JPEG_QUALITY = 85


class VisionImageError(RuntimeError):
    """A safe image-decoding or preprocessing failure."""


def prepare_vision_image(path: Path) -> bytes:
    """Orient, bound, and encode one image as an RGB JPEG for Ollama."""

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source)
                rgb_image = _to_rgb(oriented)
                target_size = _bounded_size(*rgb_image.size)
                if rgb_image.size != target_size:
                    rgb_image = rgb_image.resize(
                        target_size,
                        resample=Image.Resampling.LANCZOS,
                    )

                output = BytesIO()
                rgb_image.save(
                    output,
                    format="JPEG",
                    quality=VISION_JPEG_QUALITY,
                    optimize=True,
                    subsampling=0,
                )
                return output.getvalue()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise VisionImageError(
            "Image dimensions exceed the safe preprocessing limit."
        ) from error
    except (OSError, ValueError) as error:
        raise VisionImageError("Image could not be decoded or re-encoded.") from error


def estimate_visual_tokens(width: int, height: int) -> int:
    """Conservatively estimate Qwen visual patches after 28-pixel grouping."""

    return math.ceil(width / 28) * math.ceil(height / 28)


def _bounded_size(width: int, height: int) -> tuple[int, int]:
    if width <= 0 or height <= 0:
        raise VisionImageError("Image dimensions must be positive.")
    scale = min(
        1.0,
        VISION_MAX_LONG_EDGE / max(width, height),
        math.sqrt(VISION_MAX_PIXELS / (width * height)),
    )
    return (
        max(1, math.floor(width * scale)),
        max(1, math.floor(height * scale)),
    )


def _to_rgb(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")

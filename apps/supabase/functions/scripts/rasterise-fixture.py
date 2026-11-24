"""Rasterises a synthetic fixture (pages.md) into an image-only PDF, like a scanned contract.

Used by scripts/build-fixtures.ts for fixtures whose expected.json says "scanned": true.
Needs python3 with Pillow. Deterministic (fixed seed), A4 at 150 dpi, a slight skew and
speckle so it looks like a scan. The PDF has no text layer: the pipeline must route every
page to OCR.

    python3 -E scripts/rasterise-fixture.py <pages.md> <out.pdf>
"""

import random
import re
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def font(size):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main(src, out):
    with open(src, encoding="utf-8") as f:
        pages = [p.strip() for p in re.split(r"^--- page ---$", f.read(), flags=re.M)]
    rnd = random.Random(20260101)
    body, head = font(22), font(28)
    images = []
    for text in pages:
        img = Image.new("L", (1240, 1754), 250)
        d = ImageDraw.Draw(img)
        y = 120
        for i, line in enumerate(text.split("\n")):
            for part in textwrap.wrap(line, 88) or [""]:
                d.text((110, y), part, fill=25, font=head if i == 0 else body)
                y += 44 if i == 0 else 34
        for _ in range(1500):  # speckle
            x, yy = rnd.randrange(1240), rnd.randrange(1754)
            d.point((x, yy), fill=rnd.randrange(120, 200))
        img = img.rotate(rnd.uniform(-0.6, 0.6), resample=Image.BICUBIC, fillcolor=250)
        images.append(img.convert("RGB"))
    images[0].save(out, "PDF", resolution=150.0, save_all=True, append_images=images[1:])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

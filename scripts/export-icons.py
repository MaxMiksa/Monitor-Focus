"""Regenerate Windows icons from favicon.svg. Developer-only: CairoSVG, Pillow."""
from pathlib import Path
from io import BytesIO
import re
import cairosvg
from PIL import Image

root = Path(__file__).resolve().parents[1]
assets = root / "frontend/public"
source = re.sub(r"<style>.*?</style>", "", (assets / "favicon.svg").read_text(encoding="utf-8"), flags=re.S)
sizes = [(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
for name, color in (("app.ico", "#000000"), ("app-white.ico", "#ffffff")):
    png = cairosvg.svg2png(bytestring=source.replace("#000000", color).encode(), output_width=256, output_height=256)
    with Image.open(BytesIO(png)) as image:
        image.save(assets / name, format="ICO", sizes=sizes)

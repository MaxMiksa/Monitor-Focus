"""Derive exact alpha coverage for the component overlay from the scene weights."""
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
source = np.array(Image.open(root / 'frontend/public/scene-morph-mask-v7.png').convert('L'))
rgba = np.full((*source.shape, 4), 255, np.uint8)
rgba[:, :, 3] = np.clip((source.astype(float) - 166) / 38, 0, 1) * 255
output = root / 'frontend/public/scenes/live/sky-mask.png'
Image.fromarray(rgba).save(output, optimize=True)
print(f'{output}: {output.stat().st_size} bytes')

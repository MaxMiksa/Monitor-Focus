"""Create small lossless sky patches for moving the ORIGINAL scene seeds.

The four source WebPs stay byte-for-byte unchanged. Only hand-selected seed
heads/stems are inpainted offline. Runtime subtracts these patches from the
original photo to recover signed seed detail, including dark stems and glow.
"""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCENES = ('morning', 'midday', 'dusk', 'night')
CELL_W, CELL_H = 64, 80
# crop origin, head centre/radii, stem endpoint (all in source-image pixels).
SEEDS = (
    ((148, 502), (181, 539, 15, 10), (171, 562)),
    ((284, 481), (317, 516, 24, 17), (299, 555)),
    ((347, 450), (380, 483, 19, 12), (386, 511)),
    ((439, 550), (471, 587, 15, 10), (465, 608)),
    ((558, 529), (590, 567, 12, 9), (592, 589)),
    ((1006, 341), (1038, 379, 18, 12), (1027, 403)),
    ((1172, 554), (1204, 594, 17, 11), (1194, 615)),
    ((1264, 513), (1297, 555, 23, 14), (1289, 593)),
    ((1329, 475), (1361, 513, 16, 12), (1368, 538)),
    ((1469, 595), (1501, 634, 16, 10), (1496, 654)),
)


def main():
    atlas = np.zeros((CELL_H * len(SCENES), CELL_W * len(SEEDS), 3), np.uint8)
    output = ROOT / 'build/diagnostics/seed-motion'
    output.mkdir(parents=True, exist_ok=True)
    for row, scene in enumerate(SCENES):
        original = np.array(Image.open(ROOT / f'frontend/public/scenes/live/{scene}.webp').convert('RGB'))
        repaired = original.copy()
        all_masks = np.zeros(original.shape[:2], np.uint8)
        for column, (origin, head, end) in enumerate(SEEDS):
            x, y = origin
            crop = original[y:y + CELL_H, x:x + CELL_W].copy()
            mask = np.zeros((CELL_H, CELL_W), np.uint8)
            hx, hy, rx, ry = head
            cv2.ellipse(mask, (hx - x, hy - y), (rx, ry), 0, 0, 360, 255, -1)
            cv2.line(mask, (hx - x, hy - y + 2), (end[0] - x, end[1] - y), 255, 6)
            cv2.circle(mask, (end[0] - x, end[1] - y), 3, 255, -1)
            # The soft fringe surrounds the entire subject, including its glow.
            mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
            filled = cv2.inpaint(crop, mask, 5, cv2.INPAINT_NS)
            repaired[y:y + CELL_H, x:x + CELL_W] = filled
            all_masks[y:y + CELL_H, x:x + CELL_W] = mask
            atlas[row * CELL_H:(row + 1) * CELL_H, column * CELL_W:(column + 1) * CELL_W] = filled
        assert np.array_equal(repaired[all_masks == 0], original[all_masks == 0])
        # Review-only views do not ship in the frontend bundle.
        Image.fromarray(repaired).save(output / f'{scene}-sky-patches-review.png')
        if scene == 'morning':
            delta = original.astype(np.int16) - repaired.astype(np.int16)
            # Signed residual reconstruction must recover the source exactly.
            restored = np.clip(repaired.astype(np.int16) + delta, 0, 255).astype(np.uint8)
            assert np.array_equal(restored, original)
            moved = repaired.astype(np.int16)
            for index, (origin, _, _) in enumerate(SEEDS):
                x, y = origin
                dx = 22 if index % 2 == 0 else -18
                dy = -5 if index % 3 == 0 else 3
                moved[y + dy:y + dy + CELL_H, x + dx:x + dx + CELL_W] += delta[y:y + CELL_H, x:x + CELL_W]
            Image.fromarray(np.clip(moved, 0, 255).astype(np.uint8)).save(output / 'morning-moved-review.png')
            sheet = Image.new('RGB', (len(SEEDS) * 128, 320), '#101827')
            for index, (origin, _, _) in enumerate(SEEDS):
                x, y = origin
                sheet.paste(Image.fromarray(original[y:y + CELL_H, x:x + CELL_W]).resize((128, 160)), (index * 128, 0))
                sheet.paste(Image.fromarray(repaired[y:y + CELL_H, x:x + CELL_W]).resize((128, 160)), (index * 128, 160))
            sheet.save(output / 'patch-detail-review.png')
    target = ROOT / 'frontend/public/scenes/live/seed-sky-patches.png'
    Image.fromarray(atlas).save(target, optimize=True)
    metadata = {'imageSize': [1672, 941], 'cellSize': [CELL_W, CELL_H],
                'atlasSize': [atlas.shape[1], atlas.shape[0]], 'scenes': SCENES,
                'origins': [seed[0] for seed in SEEDS]}
    (ROOT / 'frontend/src/lib/seed-patches.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(f'{target}: {target.stat().st_size} bytes; {atlas.shape[1]} x {atlas.shape[0]} RGB')
    print('Verified: unchanged outside local masks; exact signed-detail reconstruction.')


if __name__ == '__main__':
    main()

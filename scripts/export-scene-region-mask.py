"""Offline contour-only scene weights: sky 204, grass 166, machine 141.

Uses the aligned midday source, not the old blurred mask. No seed/star labels,
horizontal bands, dilation, blur, or expanded protection regions. This changes
weight assets only; original scenes and seed extraction patches stay untouched.
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    image = np.array(Image.open(ROOT / 'frontend/public/scenes/live/midday.webp').convert('RGB'))
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    # Midday blue sky separates from green/yellow vegetation. Keep only pixels
    # connected to the foreground, so isolated floating seeds/stars stay sky.
    ground = ((hsv[:, :, 0] < 87) & (image[:, :, 1].astype(float) > image[:, :, 2] * 1.12)
              & (hsv[:, :, 1] > 20)).astype(np.uint8)
    ground[:560] = 0
    ground[735:] = 1
    _, components = cv2.connectedComponents(ground, connectivity=8)
    grass = components == components[-1, 0]

    # Tight machine ROI; GrabCut resolves the rounded silhouette and foot against
    # the original pixels. It never grows a halo around the resulting contour.
    x0, y0, x1, y1 = 705, 365, 965, 690
    crop = image[y0:y1, x0:x1]
    labels = np.full(crop.shape[:2], cv2.GC_PR_BGD, np.uint8)
    outline = np.array([(732, 377), (940, 377), (949, 379), (955, 388),
                        (955, 651), (952, 664), (943, 678), (925, 681),
                        (729, 675), (718, 665), (714, 651), (714, 397),
                        (718, 385), (724, 379)], np.int32) - (x0, y0)
    cv2.fillPoly(labels, [outline], cv2.GC_PR_FGD)
    labels[24:285, 20:239] = cv2.GC_FGD
    labels[:4] = labels[-4:] = cv2.GC_BGD
    labels[:, :4] = labels[:, -4:] = cv2.GC_BGD
    cv2.setRNGSeed(20261114)
    cv2.grabCut(crop, labels, None, np.zeros((1, 65)), np.zeros((1, 65)), 5, cv2.GC_INIT_WITH_MASK)
    machine = np.zeros((height, width), bool)
    machine[y0:y1, x0:x1] = (labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)

    mask = np.full((height, width), 204, np.uint8)
    mask[grass] = 166
    mask[machine] = 141
    master = ROOT / 'frontend/public/scene-morph-mask-v7.png'
    deployed = ROOT / 'frontend/public/scenes/live/mask.webp'
    Image.fromarray(mask).save(master, optimize=True)
    band = mask[376:705]
    assert np.array_equal(mask, np.pad(band, ((376, height-705), (0, 0)), mode='edge'))
    Image.fromarray(band).convert('RGB').save(deployed, lossless=True, method=6)
    assert set(np.unique(mask)) == {141, 166, 204}
    assert np.array_equal(np.array(Image.open(deployed).convert('L')), band)
    # Entire upper sky is a single weight, including all former white spots.
    assert np.all(mask[:370] == 204)
    proof = ROOT / 'build/diagnostics/scene-region-mask'
    proof.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask).save(proof / 'contour-mask.png')
    palette = np.zeros_like(image)
    palette[mask == 204] = (80, 160, 240)
    palette[mask == 166] = (80, 220, 100)
    palette[mask == 141] = (240, 130, 90)
    overlay = np.rint(image * .75 + palette * .25).astype(np.uint8)
    Image.fromarray(overlay).save(proof / 'contours-overlay.png')
    print(f'{width} x {height}; only grayscale values 141 / 166 / 204')
    print(f'WebP: {deployed.stat().st_size} bytes; lossless master match verified')


if __name__ == '__main__':
    main()

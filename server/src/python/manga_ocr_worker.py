"""Batch manga OCR worker: RapidOCR text detection + manga-ocr recognition.

Reads a JSON request on stdin:
  {"image": "path/to/page.jpg", "min_area": 40, "pad": 6}

Pipeline:
  1. RapidOCR (pure ONNX) detects text regions -> tight boxes.
  2. Each region is cropped (with padding) and recognized by manga-ocr.

Outputs JSON on stdout:
  [{"text":"...", "conf":0.99, "x0":..,"y0":..,"x1":..,"y1":..}]

Exit code 0 on success, 1 on failure.
"""
import json
import sys

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


def main() -> int:
    raw = sys.stdin.buffer.read()
    try:
        req = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"invalid request: {exc}"}))
        return 1

    image_path = req.get("image")
    if not image_path:
        print(json.dumps({"error": "image is required"}))
        return 1
    min_area = float(req.get("min_area", 40))
    pad = int(req.get("pad", 6))

    try:
        img = Image.open(image_path).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"cannot open image: {exc}"}))
        return 1

    try:
        from manga_ocr import MangaOcr

        mocr = MangaOcr()
        ocr = True
    except Exception as exc:  # noqa: BLE001
        err = json.dumps({"error": f"model load failed: {exc}"})
        print(err)
        return 1

    dt_boxes = []
    try:
        detector = RapidOCR()
        dt_boxes, _ = detector.text_detector(np.array(img))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"detection failed: {exc}"}))
        return 1

    boxes = dt_boxes.tolist() if isinstance(dt_boxes, np.ndarray) and dt_boxes.size else (dt_boxes or [])
    results = []
    for quad in boxes:
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        x0 = int(min(xs))
        y0 = int(min(ys))
        x1 = int(max(xs))
        y1 = int(max(ys))
        if (x1 - x0) * (y1 - y0) < min_area:
            continue
        cx0 = max(0, x0 - pad)
        cy0 = max(0, y0 - pad)
        cx1 = min(img.width, x1 + pad)
        cy1 = min(img.height, y1 + pad)
        text = ""
        if cx1 > cx0 and cy1 > cy0:
            try:
                text = mocr(img.crop((cx0, cy0, cx1, cy1)))
            except Exception as exc:  # noqa: BLE001
                print(json.dumps({"error": f"ocr failed: {exc}"}))
                return 1
        results.append({"text": text or "", "conf": 1.0, "x0": x0, "y0": y0, "x1": x1, "y1": y1})

    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
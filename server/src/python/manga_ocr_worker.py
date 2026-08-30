"""Manga OCR worker: RapidOCR text detection + manga-ocr recognition.

Two modes:

  one-shot (default)
      Reads a single JSON request on stdin, writes one JSON reply on stdout.

  server (``--serve``)
      Reads one JSON request per line on stdin and writes one JSON reply per
      line on stdout, keeping the models resident. The ONNX recognition model is
      ~400 MB and takes several seconds to load, so re-spawning per page made
      whole-chapter translation unusably slow.

Request:
  {"image": "path/to/page.jpg", "mode": "manga"|"detect", "min_area": 40, "pad": 6}

``detect`` returns boxes only. The RapidOCR detector is a script-agnostic text
detector, so it finds bubbles on Georgian or Hebrew scans just as well as on
Japanese ones; the caller then recognizes each crop with whatever engine suits
the language. Full-page tesseract layout analysis, by contrast, merges text
across panel borders on comics.

Reply:
  {"lines": [{"text":"...", "conf":0.99, "x0":..,"y0":..,"x1":..,"y1":..}]}
  {"error": "..."}

Exit code 0 on success, 1 on failure (one-shot mode only).
"""
import json
import sys

import numpy as np
from PIL import Image

_detector = None
_recognizer = None

# RapidOCR ships thresholds tuned for photographs of documents. Comic lettering
# is often thin, light grey or outlined, and the stock settings miss it: on a
# Georgian webtoon page the defaults found 3 of 5 text areas and skipped both
# dialogue lines. These are deliberately permissive - spurious boxes cost one
# wasted recognition call, whereas a missed box loses a whole speech bubble.
DET_DEFAULTS = {
    "thresh": 0.15,
    "box_thresh": 0.25,
    "unclip_ratio": 1.8,
    "side_len": 1280,
}


def load_detector(params=None):
    """Loads the (script-agnostic) text detector once per process."""
    global _detector
    if _detector is None:
        from rapidocr_onnxruntime import RapidOCR

        _detector = RapidOCR()
    tuning = dict(DET_DEFAULTS)
    tuning.update(params or {})
    post = _detector.text_detector.postprocess_op
    post.thresh = float(tuning["thresh"])
    post.box_thresh = float(tuning["box_thresh"])
    post.unclip_ratio = float(tuning["unclip_ratio"])
    _detector.text_detector.preprocess_op[0].limit_side_len = int(tuning["side_len"])
    return _detector


def load_recognizer():
    """Loads the Japanese recognition model; ~400 MB, so only on demand."""
    global _recognizer
    if _recognizer is None:
        from manga_ocr import MangaOcr

        _recognizer = MangaOcr()
    return _recognizer


def recognize(req):
    """Runs detection + recognition for one request dict; returns a reply dict."""
    image_path = req.get("image")
    if not image_path:
        return {"error": "image is required"}
    mode = req.get("mode", "manga")
    min_area = float(req.get("min_area", 40))
    pad = int(req.get("pad", 6))

    try:
        img = Image.open(image_path).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        return {"error": f"cannot open image: {exc}"}

    try:
        detector = load_detector(req.get("detect"))
        mocr = load_recognizer() if mode == "manga" else None
    except Exception as exc:  # noqa: BLE001
        return {"error": f"model load failed: {exc}"}

    try:
        dt_boxes, _ = detector.text_detector(np.array(img))
    except Exception as exc:  # noqa: BLE001
        return {"error": f"detection failed: {exc}"}

    boxes = (
        dt_boxes.tolist()
        if isinstance(dt_boxes, np.ndarray) and dt_boxes.size
        else (dt_boxes or [])
    )
    results = []
    for quad in boxes:
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        x0, y0 = int(min(xs)), int(min(ys))
        x1, y1 = int(max(xs)), int(max(ys))
        if (x1 - x0) * (y1 - y0) < min_area:
            continue
        cx0 = max(0, x0 - pad)
        cy0 = max(0, y0 - pad)
        cx1 = min(img.width, x1 + pad)
        cy1 = min(img.height, y1 + pad)
        if cx1 <= cx0 or cy1 <= cy0:
            continue
        if mocr is None:
            results.append(
                {"text": "", "conf": 1.0, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
            )
            continue
        try:
            text = mocr(img.crop((cx0, cy0, cx1, cy1)))
        except Exception as exc:  # noqa: BLE001
            return {"error": f"ocr failed: {exc}"}
        if not text:
            continue
        results.append(
            {"text": text, "conf": 1.0, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
        )

    return {"lines": results}


def serve() -> int:
    """Line-delimited request/reply loop; stays up until stdin closes."""
    try:
        load_detector()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"detector load failed: {exc}"}), flush=True)
        return 1
    # Tells the parent the models are resident and requests may start.
    print(json.dumps({"ready": True}), flush=True)

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"invalid request: {exc}"}), flush=True)
            continue
        try:
            reply = recognize(req)
        except Exception as exc:  # noqa: BLE001
            reply = {"error": f"unexpected failure: {exc}"}
        print(json.dumps(reply), flush=True)
    return 0


def main() -> int:
    if "--serve" in sys.argv[1:]:
        return serve()

    raw = sys.stdin.buffer.read()
    try:
        req = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"invalid request: {exc}"}))
        return 1
    reply = recognize(req)
    print(json.dumps(reply))
    return 1 if "error" in reply else 0


if __name__ == "__main__":
    sys.exit(main())

/**
 * Page OCR with per-language engine routing.
 *
 * Two things were wrong before. `manga-ocr` is a Japanese-only recognition
 * model, and the old `TRANSLATE_SRC=jpn` override pointed it at every chapter,
 * so Georgian and English scans came back as confident nonsense. And when
 * tesseract did run, it ran over the whole page: its document layout analysis
 * merges text across panel borders on comics, producing 800px-wide "lines" that
 * span three speech bubbles.
 *
 * So detection and recognition are split. RapidOCR's detector (in the Python
 * sidecar) is script-agnostic and finds tight per-line boxes on any language;
 * each crop is then recognized by whatever engine suits the chapter — manga-ocr
 * for Japanese, tesseract with the matching traineddata for everything else.
 * Without the sidecar we fall back to whole-page tesseract in sparse-text mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { dataDir } from '../config';
import { chapterDir } from '../db';
import { langSpec, type LangSpec } from './lang';
import { detectTextBoxes, isMangaOcrAvailable, mangaOcrPage, type MangaOcrLine } from './mangaOcr';
import type { OcrLine } from './textBlocks';

export type OcrEngine = 'mangaocr' | 'detect+tesseract' | 'tesseract';

export interface PageOcrResult {
  engine: OcrEngine;
  /** traineddata / model language actually used. */
  lang: string;
  lines: OcrLine[];
}

/** tesseract.js caches traineddata here; shared across chapters on purpose. */
const traineddataDir = path.join(dataDir, '.ocr');
fs.mkdirSync(traineddataDir, { recursive: true });

/** Languages whose traineddata could not be fetched: do not retry every page. */
const unavailableLangs = new Set<string>();

let ocrSemaphore = Promise.resolve();

/** Serialize OCR runs so model loads and traineddata downloads do not pile up. */
function withOcrSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = ocrSemaphore.then(fn, fn);
  ocrSemaphore = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Opens a tesseract worker, remembering languages whose data cannot be had. */
async function openWorker(lang: string, psm: PSM): Promise<{ worker: Worker; lang: string } | null> {
  const attempts = unavailableLangs.has(lang) ? ['eng'] : [lang, 'eng'];
  for (const candidate of attempts) {
    try {
      const worker = await createWorker(candidate, 1, { cachePath: traineddataDir } as never);
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      return { worker, lang: candidate };
    } catch (err) {
      unavailableLangs.add(candidate);
      console.warn(
        `[ocr] traineddata "${candidate}" unavailable: ` +
          `${err instanceof Error ? err.message : err}${candidate === 'eng' ? '' : '; falling back to eng'}`,
      );
    }
  }
  return null;
}

/**
 * Recognizes pre-detected boxes one at a time in single-line mode. Small crops
 * are upscaled first: tesseract needs roughly 30px of cap height to be
 * accurate, and manga lettering is often well below that.
 */
async function recognizeCrops(
  localPath: string,
  boxes: MangaOcrLine[],
  spec: LangSpec,
): Promise<{ lines: OcrLine[]; lang: string } | null> {
  const opened = await openWorker(spec.tesseract, PSM.SINGLE_LINE);
  if (!opened) return null;

  const img = await loadImage(localPath);
  const lines: OcrLine[] = [];
  try {
    for (const box of boxes) {
      const pad = Math.max(3, Math.round((box.y1 - box.y0) * 0.18));
      const sx = Math.max(0, box.x0 - pad);
      const sy = Math.max(0, box.y0 - pad);
      const sw = Math.min(img.width, box.x1 + pad) - sx;
      const sh = Math.min(img.height, box.y1 + pad) - sy;
      if (sw < 4 || sh < 4) continue;

      const scale = Math.min(4, Math.max(1, 48 / sh));
      const crop = createCanvas(Math.round(sw * scale), Math.round(sh * scale));
      const cropCtx = crop.getContext('2d');
      cropCtx.fillStyle = '#ffffff';
      cropCtx.fillRect(0, 0, crop.width, crop.height);
      cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

      const { data } = await opened.worker.recognize(crop.toBuffer('image/png'));
      const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
      const conf = data.confidence ?? 0;
      if (!text) continue;
      lines.push({ text, conf, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 });
    }
  } finally {
    await opened.worker.terminate();
  }
  return { lines, lang: opened.lang };
}

/** Whole-page tesseract, used only when the detection sidecar is unavailable. */
async function tesseractPage(
  localPath: string,
  spec: LangSpec,
): Promise<{ lines: OcrLine[]; lang: string } | null> {
  // Sparse text mode makes no assumption about columns or reading order, which
  // is much closer to how a comic page is laid out than the default.
  const opened = await openWorker(spec.tesseract, PSM.SPARSE_TEXT);
  if (!opened) return null;

  try {
    const { data } = await opened.worker.recognize(localPath, {}, { text: true, blocks: true });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          const text = (line.text ?? '').replace(/\s+/g, ' ').trim();
          const conf = line.confidence ?? 0;
          if (!text) continue;
          const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
          lines.push({ text, conf, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
        }
      }
    }
    return { lines, lang: opened.lang };
  } finally {
    await opened.worker.terminate();
  }
}

function cachePath(titleId: string, chapterId: string, pageNumber: number, tag: string): string {
  const dir = path.join(chapterDir(titleId, chapterId), '.ocr');
  fs.mkdirSync(dir, { recursive: true });
  // Keyed by chapter directory: the old flat cache keyed on file basename alone
  // let page 5 of one title serve page 5 of another.
  return path.join(dir, `${pageNumber}.${tag}.json`);
}

export interface OcrPageOptions {
  titleId: string;
  chapterId: string;
  pageNumber: number;
  localPath: string;
  /** MangaDex language code of the chapter being read. */
  sourceLang: string;
}

/** OCRs a page, caching the raw result next to the chapter's images. */
export async function ocrPage(opts: OcrPageOptions): Promise<PageOcrResult> {
  const spec = langSpec(opts.sourceLang);
  const sidecar = isMangaOcrAvailable();
  const japanese = spec.script === 'jpn';
  const engine: OcrEngine = sidecar ? (japanese ? 'mangaocr' : 'detect+tesseract') : 'tesseract';
  const cacheFile = cachePath(opts.titleId, opts.chapterId, opts.pageNumber, `${spec.code}.${engine}`);

  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as PageOcrResult;
    } catch {
      /* corrupt cache entry: fall through and re-OCR */
    }
  }

  const result = await withOcrSlot(async (): Promise<PageOcrResult> => {
    if (sidecar && japanese) {
      const manga = await mangaOcrPage(opts.localPath);
      if (manga && manga.length > 0) {
        return {
          engine: 'mangaocr',
          lang: 'jpn',
          lines: manga
            .filter((l) => l.text.trim().length > 0)
            .map((l) => ({
              text: l.text,
              conf: Math.max(0, Math.min(100, l.conf * 100)),
              x0: l.x0,
              y0: l.y0,
              x1: l.x1,
              y1: l.y1,
            })),
        };
      }
      console.warn(`[ocr] manga-ocr found no text on page ${opts.pageNumber}; trying tesseract`);
    } else if (sidecar) {
      const boxes = await detectTextBoxes(opts.localPath);
      if (boxes && boxes.length > 0) {
        const recognized = await recognizeCrops(opts.localPath, boxes, spec);
        if (recognized && recognized.lines.length > 0) {
          return { engine: 'detect+tesseract', lang: recognized.lang, lines: recognized.lines };
        }
      }
      console.warn(
        `[ocr] detection found nothing usable on page ${opts.pageNumber}; trying whole-page tesseract`,
      );
    }

    const fallback = await tesseractPage(opts.localPath, spec);
    return { engine: 'tesseract', lang: fallback?.lang ?? spec.tesseract, lines: fallback?.lines ?? [] };
  });

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(result));
  } catch {
    /* cache is best-effort */
  }
  return result;
}

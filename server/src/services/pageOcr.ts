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
async function openWorker(lang: string): Promise<{ worker: Worker; lang: string } | null> {
  const attempts = unavailableLangs.has(lang) ? ['eng'] : [lang, 'eng'];
  for (const candidate of attempts) {
    try {
      const worker = await createWorker(candidate, 1, { cachePath: traineddataDir } as never);
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

/** How long a loaded tesseract worker is kept after its last use. */
const WORKER_IDLE_MS = 5 * 60_000;

interface WarmWorker {
  worker: Worker;
  /** traineddata actually loaded (`eng` when the language had none). */
  lang: string;
  idle: NodeJS.Timeout | null;
}

/** One loaded worker per language, kept between pages. */
const warm = new Map<string, Promise<WarmWorker | null>>();

/**
 * Runs `fn` with a loaded tesseract worker for `lang`.
 *
 * Workers used to be created and torn down for every page, and again for the
 * re-read pass, reloading the WASM engine and the traineddata each time. They
 * now stay loaded until idle for a while. OCR is serialized (`withOcrSlot`), so
 * a worker is never used by two callers at once.
 */
async function useWorker<T>(
  lang: string,
  psm: PSM,
  fn: (worker: Worker, lang: string) => Promise<T>,
): Promise<T | null> {
  let entry = warm.get(lang);
  if (!entry) {
    entry = openWorker(lang).then((opened) => (opened ? { ...opened, idle: null } : null));
    warm.set(lang, entry);
  }
  const held = await entry;
  if (!held) {
    warm.delete(lang);
    return null;
  }
  if (held.idle) clearTimeout(held.idle);
  held.idle = null;
  try {
    await held.worker.setParameters({ tessedit_pageseg_mode: psm });
    return await fn(held.worker, held.lang);
  } catch (err) {
    // A worker that failed mid-page is not trusted with the next one.
    warm.delete(lang);
    void held.worker.terminate().catch(() => {});
    throw err;
  } finally {
    if (warm.get(lang) === entry) {
      held.idle = setTimeout(() => {
        warm.delete(lang);
        void held.worker.terminate().catch(() => {});
      }, WORKER_IDLE_MS);
      held.idle.unref?.();
    }
  }
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
  const img = await loadImage(localPath);
  return useWorker(spec.tesseract, PSM.SINGLE_LINE, async (worker, lang) => {
    const lines: OcrLine[] = [];
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

      const { data } = await worker.recognize(crop.toBuffer('image/png'));
      const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
      const conf = data.confidence ?? 0;
      if (!text) continue;
      lines.push({ text, conf, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 });
    }
    return { lines, lang };
  });
}

/** Whole-page tesseract, used only when the detection sidecar is unavailable. */
async function tesseractPage(
  localPath: string,
  spec: LangSpec,
): Promise<{ lines: OcrLine[]; lang: string } | null> {
  // Sparse text mode makes no assumption about columns or reading order, which
  // is much closer to how a comic page is laid out than the default.
  return useWorker(spec.tesseract, PSM.SPARSE_TEXT, async (worker, lang) => {
    const { data } = await worker.recognize(localPath, {}, { text: true, blocks: true });
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
    return { lines, lang };
  });
}

/** Region of a page to re-read, tagged with the block it belongs to. */
export interface RefineRegion {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Re-reads whole bubbles as single blocks of text.
 *
 * The per-line pass drops short lines -- a two-letter middle line often falls
 * under the confidence floor -- and a bubble then splits into two blocks with
 * the missing line's words gone for good. Once bubble geometry is known, the
 * balloon can be handed to tesseract as one uniform block, which reads all of
 * its lines together and in order. Returns raw text per region id; the caller
 * decides whether it beats what the first pass assembled.
 *
 * Results are cached per page when `page` is given. The same page and balloons
 * always re-read the same way, and every render used to run this again.
 */
export async function refineRegions(
  localPath: string,
  regions: RefineRegion[],
  sourceLang: string,
  page?: { titleId: string; chapterId: string; pageNumber: number },
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (regions.length === 0) return out;
  const spec = langSpec(sourceLang);
  // manga-ocr is recognition-only and has no notion of page segmentation, so
  // Japanese pages keep the first pass as-is.
  if (spec.script === 'jpn') return out;

  const file = page ? cachePath(page.titleId, page.chapterId, page.pageNumber, `${spec.code}.refine`) : null;
  const key = JSON.stringify(regions);
  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { regions: string; texts: [number, string][] };
      if (saved.regions === key) return new Map(saved.texts);
    } catch {
      /* corrupt entry: re-read below */
    }
  }

  const reread = await withOcrSlot(async () => {
    const img = await loadImage(localPath);
    return useWorker(spec.tesseract, PSM.SINGLE_BLOCK, async (worker) => {
      for (const region of regions) {
        const sx = Math.max(0, Math.round(region.x0));
        const sy = Math.max(0, Math.round(region.y0));
        const sw = Math.min(img.width, Math.round(region.x1)) - sx;
        const sh = Math.min(img.height, Math.round(region.y1)) - sy;
        if (sw < 8 || sh < 8) continue;

        const scale = Math.min(3, Math.max(1, 260 / Math.max(sw, sh)));
        const crop = createCanvas(Math.round(sw * scale), Math.round(sh * scale));
        const ctx = crop.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, crop.width, crop.height);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

        const { data } = await worker.recognize(crop.toBuffer('image/png'));
        const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
        if (text) out.set(region.id, text);
      }
      return out;
    });
  });
  if (!reread) return out;

  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify({ regions: key, texts: [...reread] }));
    } catch {
      /* cache is best-effort */
    }
  }
  return reread;
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

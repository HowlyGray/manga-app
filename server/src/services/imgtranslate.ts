import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { config, dataDir } from '../config';
import { chapterDir } from '../db';
import { listPages } from './library';
import { translateLines } from './translator';
import { isMangaOcrAvailable, mangaOcrPage } from './mangaOcr';

interface OcrLine {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TranslatedPage {
  buffer: Buffer;
  mime: string;
  fromCache: boolean;
  translated: boolean;
}

// OCR result cache directory (persists across restarts).
const ocrRoot = path.join(dataDir, '.ocr');
fs.mkdirSync(ocrRoot, { recursive: true });

let ocrSemaphore = Promise.resolve();

/** Serialize OCR runs so traineddata downloads / worker spawns don't pile up. */
function withOcrSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = ocrSemaphore.then(fn, fn);
  ocrSemaphore = run.then(() => undefined, () => undefined);
  return run;
}

async function ocrLines(filePath: string, sourceLang: string): Promise<OcrLine[]> {
  const lang = config.translate.ocrSource || sourceLang;
  // Manga-OCR (RapidOCR detection + manga-ocr recognition) is used for
  // Japanese pages; tesseract is the fallback and covers other languages.
  const useManga = lang === 'jpn' && isMangaOcrAvailable();
  const engineTag = useManga ? '.mangaocr' : '';
  const cacheKey = `${path.basename(filePath)}.${lang}${engineTag}.json`;
  const cachePath = path.join(ocrRoot, cacheKey);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as OcrLine[];
    } catch {
      /* re-ocr below */
    }
  }

  const lines = await withOcrSlot(async () => {
    if (useManga) {
      try {
        const manga = await mangaOcrPage(filePath);
        if (manga && manga.length > 0) {
          return manga
            .filter((l) => l.text.trim().length > 0)
            .map((l) => ({ text: l.text, conf: Math.max(0, Math.min(100, l.conf * 100)), x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }));
        }
        console.warn(`[translate] manga-ocr returned no lines for ${path.basename(filePath)}; falling back to tesseract`);
      } catch (err) {
        console.error(`[translate] manga-ocr failed for ${path.basename(filePath)}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Tesseract fallback (also used for non-Japanese languages).
    const worker = await createWorker(lang, 1, { cachePath: ocrRoot } as never);
    try {
      const { data } = await worker.recognize(filePath, {}, { text: true, blocks: true });
      const out: OcrLine[] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const line of para.lines ?? []) {
            const text = (line.text ?? '').trim();
            if (!text || (line.confidence ?? 0) < 35) continue;
            const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
            out.push({ text, conf: line.confidence ?? 0, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
          }
        }
      }
      return out;
    } finally {
      await worker.terminate();
    }
  });

  try {
    fs.writeFileSync(cachePath, JSON.stringify(lines));
  } catch {
    /* cache best-effort */
  }
  return lines;
}

function isCjk(text: string): boolean {
  return /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text);
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, vertical: boolean): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  if (vertical) {
    for (const ch of chars) lines.push(ch);
    return lines;
  }
  const hasSpaces = /\s/.test(text);
  if (!hasSpaces && chars.length > 0 && isCjk(text)) {
    // Break CJK by characters into lines that fit.
    let line = '';
    for (const ch of chars) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  }
  const words = text.split(/\s+/);
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

/** Average color of pixels just outside a box (used to erase the old text). */
function estimateBackground(ctx: SKRSContext2D, x0: number, y0: number, x1: number, y1: number): string {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const pad = 3;
  const samples: [number, number][] = [];
  const grab = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) samples.push([x + dx, y + dy]);
    }
  };
  for (let x = x0 - pad; x <= x1 + pad; x++) {
    grab(x, y0 - pad);
    grab(x, y1 + pad);
  }
  for (let y = y0 - pad; y <= y1 + pad; y++) {
    grab(x0 - pad, y);
    grab(x1 + pad, y);
  }
  if (samples.length === 0) return 'rgb(255,255,255)';
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  let r = 0, g = 0, b = 0;
  for (const [x, y] of samples) {
    const i = (y * w + x) * 4;
    r += px[i]; g += px[i + 1]; b += px[i + 2];
  }
  const n = samples.length;
  return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
}

function drawBox(ctx: SKRSContext2D, box: OcrLine, translated: string) {
  const { x0, y0, x1, y1 } = box;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;

  const vertical = bw < bh * 0.75;
  const padX = Math.max(2, Math.round(bw * 0.04));
  const padY = Math.max(2, Math.round(bh * 0.04));
  const fillX0 = x0 - padX;
  const fillY0 = y0 - padY;
  const fillX1 = x1 + padX;
  const fillY1 = y1 + padY;
  const fillW = fillX1 - fillX0;
  const fillH = fillY1 - fillY0;

  const bg = estimateBackground(ctx, x0, y0, x1, y1);
  ctx.fillStyle = bg;
  ctx.fillRect(fillX0, fillY0, fillW, fillH);

  const maxWidth = fillW - padX * 3;
  const maxHeight = fillH - padY * 3;
  let size = vertical ? Math.min(44, Math.max(14, Math.floor(fillH / 3))) : 28;
  let lines: string[] = [];

  for (;;) {
    ctx.font = `bold ${size}px sans-serif`;
    lines = wrapText(ctx, translated, maxWidth, vertical);
    const totalH = lines.length * size * (vertical ? 1.15 : 1.05);
    if ((totalH <= maxHeight || size <= 9) && lines.length > 0) break;
    size -= 1;
  }
  if (lines.length === 0) return;

  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = 'center';

  const cx = fillX0 + fillW / 2;
  const cy = fillY0 + fillH / 2;
  if (vertical) {
    // Draw glyphs top-to-bottom, columns right-to-left (manga convention).
    const charsPerCol = Math.max(1, Math.floor(maxHeight / (size * 1.15)));
    const cols: string[][] = [];
    for (let i = 0; i < lines.length; i += charsPerCol) {
      cols.push(lines.slice(i, i + charsPerCol));
    }
    const colWidth = size * 1.1;
    const xStart = fillX1 - padX - colWidth;
    cols.forEach((col, ci) => {
      const colCx = xStart - ci * colWidth + size / 2;
      col.forEach((ch, ri) => {
        ctx.fillText(ch, colCx, fillY0 + padY + ri * size * 1.15);
      });
    });
  } else {
    const lineH = lines.length * size * 1.08;
    let y = cy - lineH / 2 + size * 0.5;
    for (const line of lines) {
      ctx.fillText(line, cx, y);
      y += size * 1.08;
    }
  }
}

/**
 * Translates the text found on a page image by OCR-ing the source language,
 * machine-translating the text, erasing the original glyphs and redrawing the
 * translation fitted back into each speech box. Results are cached on disk.
 */
export async function translatePage(opts: {
  titleId: string;
  chapterId: string;
  pageNumber: number;
  sourceLang: string;
  targetLang: string;
  localPath: string;
}): Promise<TranslatedPage> {
  const { titleId, chapterId, pageNumber, sourceLang, targetLang, localPath } = opts;

  const trlDir = path.join(chapterDir(titleId, chapterId), '.trl');
  fs.mkdirSync(trlDir, { recursive: true });
  const outPath = path.join(trlDir, `${pageNumber}.${targetLang}.png`);
  if (fs.existsSync(outPath)) {
    return { buffer: fs.readFileSync(outPath), mime: 'image/png', fromCache: true, translated: true };
  }

  const ext = path.extname(localPath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

  const lines = await ocrLines(localPath, sourceLang);
  if (lines.length === 0) {
    return { buffer: fs.readFileSync(localPath), mime, fromCache: false, translated: false };
  }

  const sources = lines.map((l) => l.text);
  const tr = await translateLines(sources, targetLang, sourceLang);
  const targets = tr.lines;

  const img = await loadImage(localPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const ordered = lines
    .map((l, i) => ({ ...l, translated: targets[i] ?? l.text }))
    .filter((l) => l.translated.trim() !== '')
    .sort((a, b) => (b.y1 - b.y0) * (b.x1 - b.x0) - (a.y1 - a.y0) * (a.x1 - a.x0));

  for (const box of ordered) {
    drawBox(ctx, box, box.translated);
  }

  const buffer = canvas.toBuffer('image/png');
  try {
    fs.writeFileSync(outPath, buffer);
  } catch {
    /* cache best-effort */
  }
  return { buffer, mime: 'image/png', fromCache: false, translated: true };
}

/** Look up a downloaded page's local path for a title/chapter. */
export function pageLocalPath(titleId: string, chapterId: string, pageNumber: number): string | null {
  return listPages(chapterId).find((p) => p.page_number === pageNumber)?.local_path ?? null;
}

export { listPages };
export type { OcrLine };

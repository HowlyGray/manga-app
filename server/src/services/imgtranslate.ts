/**
 * Page translation: OCR -> bubble grouping -> translation -> layout.
 *
 * The result of that pipeline is a `PageOverlay`: a description of every text
 * block with its bubble geometry, the fitted font size and the wrapped lines.
 * The reader can draw it as live HTML on top of the untouched scan, and the
 * same structure is what bakes the flattened PNG — so both views always agree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { config } from '../config';
import { chapterDir } from '../db';
import { eraseInto, fitBubble, type BubbleFit, type PageRaster } from './bubble';
import { fontStack } from './fonts';
import { isSameLanguage, langSpec, targetScript, wrapsAnywhere, type Script } from './lang';
import { ocrPage } from './pageOcr';
import { listPages } from './library';
import { groupIntoBlocks, type TextBlock } from './textBlocks';
import { translateBlocks, type Provider } from './translator';

/** Bump when the overlay shape changes so stale caches are regenerated. */
const OVERLAY_VERSION = 3;

export interface OverlayBlock {
  id: number;
  /** Box the source text occupied, in page pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Box the translation is laid out in — the bubble interior when detected. */
  rx0: number;
  ry0: number;
  rx1: number;
  ry1: number;
  /** Recognized source text, kept so the reader can show the original. */
  source: string;
  /** Translated text. */
  text: string;
  /** Source ran in vertical columns (output is always horizontal). */
  vertical: boolean;
  /** Sits inside a uniform bubble we can repaint. */
  inBubble: boolean;
  /** Bubble colour, `rgb(r,g,b)`. */
  fill: string;
  /** Ink colour that reads against `fill`. */
  color: string;
  /** Font size in page pixels. */
  fontSize: number;
  lineHeight: number;
  /** Server-side wrapping, used by the baked render. */
  lines: string[];
}

export interface PageOverlay {
  v: number;
  width: number;
  height: number;
  /** MangaDex language code the page was OCR'd as. */
  sourceLang: string;
  sourceLabel: string;
  targetLang: string;
  engine: string;
  provider: Provider;
  translated: boolean;
  /** Why nothing was translated, when `translated` is false. */
  reason?: 'same-language' | 'no-text';
  blocks: OverlayBlock[];
}

export interface TranslatedPage {
  buffer: Buffer;
  mime: string;
  fromCache: boolean;
  translated: boolean;
}

export interface TranslateOptions {
  titleId: string;
  chapterId: string;
  pageNumber: number;
  /** MangaDex language code of the chapter (not of the title). */
  sourceLang: string;
  /** DeepL-style target code, e.g. `FR`. */
  targetLang: string;
  localPath: string;
}

// Scratch context used purely to measure text while fitting.
const measureCanvas = createCanvas(8, 8);
const measureCtx = measureCanvas.getContext('2d');

function trlDir(titleId: string, chapterId: string): string {
  const dir = path.join(chapterDir(titleId, chapterId), '.trl');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Cache names carry the pipeline version. Keeping it out of the filename let a
 * stale render from an older pipeline keep being served next to a freshly
 * regenerated overlay; files from a previous version are simply never read
 * again, and `.trl/` can be deleted wholesale at any time.
 */
function overlayPath(o: TranslateOptions): string {
  return path.join(
    trlDir(o.titleId, o.chapterId),
    `${o.pageNumber}.${o.targetLang}.v${OVERLAY_VERSION}.json`,
  );
}

/** `baked` also draws the translation; `clean` only erases the original text. */
export type RenderVariant = 'baked' | 'clean';

function imagePath(o: TranslateOptions, variant: RenderVariant): string {
  const suffix = variant === 'clean' ? '.clean' : '';
  return path.join(
    trlDir(o.titleId, o.chapterId),
    `${o.pageNumber}.${o.targetLang}.v${OVERLAY_VERSION}${suffix}.png`,
  );
}

function readOverlay(file: string): PageOverlay | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PageOverlay;
    return parsed.v === OVERLAY_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {
    /* cache is best-effort */
  }
}

/** Wraps `text` to `maxWidth` at the current font, per the target's script. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, script: Script): string[] {
  const lines: string[] = [];
  if (wrapsAnywhere(script)) {
    let line = '';
    for (const ch of Array.from(text)) {
      if (line && ctx.measureText(line + ch).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    if (line) lines.push(line);
    return lines;
  }

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = lines.length > 0 ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length > 0 && ctx.measureText(candidate).width <= maxWidth) {
      lines[lines.length - 1] = candidate;
      continue;
    }
    // A single word longer than the box has to be broken mid-word.
    if (ctx.measureText(word).width > maxWidth && word.length > 1) {
      let piece = '';
      for (const ch of word) {
        if (piece && ctx.measureText(piece + ch).width > maxWidth) {
          lines.push(piece);
          piece = ch;
        } else piece += ch;
      }
      if (piece) lines.push(piece);
      continue;
    }
    lines.push(word);
  }
  return lines.length > 0 ? lines : [text];
}

interface Layout {
  fontSize: number;
  lineHeight: number;
  lines: string[];
}

/**
 * Picks the largest font size at which the translation still fits the render
 * box. Output is always horizontal, even for vertical Japanese sources: the old
 * renderer drew translated Latin text one character per line.
 */
function layoutText(
  text: string,
  boxW: number,
  boxH: number,
  script: Script,
  sourceLineHeight: number,
): Layout {
  const family = fontStack(script);
  const maxWidth = Math.max(8, boxW * 0.92);
  const maxHeight = Math.max(8, boxH * 0.94);
  const lineFactor = 1.16;

  // Never letter much larger than the original did: when neighbouring bubbles
  // merge into one fill region the layout box overshoots, and unbounded sizing
  // then splashes a two-word line across the whole panel.
  const sourceCap = Math.max(11, Math.round(sourceLineHeight * 1.5));
  const upper = Math.round(Math.min(46, sourceCap, Math.max(11, maxHeight * 0.8)));
  const words = wrapsAnywhere(script) ? [] : text.split(/\s+/).filter(Boolean);
  let best: Layout = { fontSize: 9, lineHeight: 9 * lineFactor, lines: [text] };

  for (let size = upper; size >= 9; size--) {
    measureCtx.font = `bold ${size}px ${family}`;
    const lines = wrapText(measureCtx, text, maxWidth, script);
    const widest = lines.reduce((m, l) => Math.max(m, measureCtx.measureText(l).width), 0);
    const height = lines.length * size * lineFactor;
    best = { fontSize: size, lineHeight: size * lineFactor, lines };
    if (height > maxHeight || widest > maxWidth) continue;
    // Prefer a smaller font over hyphen-less mid-word breaks ("geschlosse n").
    const longest = words.reduce((m, wd) => Math.max(m, measureCtx.measureText(wd).width), 0);
    if (longest > maxWidth) continue;
    break;
  }
  return best;
}

/** Runs the whole pipeline for one page. */
async function analyze(
  opts: TranslateOptions,
  cached: PageOverlay | null,
): Promise<{ overlay: PageOverlay; fits: Map<number, BubbleFit> }> {
  const spec = langSpec(opts.sourceLang);
  const script = targetScript(opts.targetLang);
  const fits = new Map<number, BubbleFit>();

  const img = await loadImage(opts.localPath);
  const base: PageOverlay = {
    v: OVERLAY_VERSION,
    width: img.width,
    height: img.height,
    sourceLang: spec.code,
    sourceLabel: spec.label,
    targetLang: opts.targetLang,
    engine: 'none',
    provider: 'none',
    translated: false,
    blocks: [],
  };

  if (isSameLanguage(opts.sourceLang, opts.targetLang)) {
    return { overlay: { ...base, reason: 'same-language' }, fits };
  }

  const ocr = await ocrPage({
    titleId: opts.titleId,
    chapterId: opts.chapterId,
    pageNumber: opts.pageNumber,
    localPath: opts.localPath,
    sourceLang: spec.code,
  });
  base.engine = ocr.engine;

  const blocks: TextBlock[] = groupIntoBlocks(ocr.lines, {
    script: spec.script,
    rtl: spec.rtl,
    minConfidence: config.translate.minConfidence,
    width: img.width,
    height: img.height,
  });
  if (blocks.length === 0) {
    return { overlay: { ...base, reason: 'no-text' }, fits };
  }

  // One raster grab for the page: the old code re-read the full image for every
  // single box, which on a 35-box page copied ~200 MB of pixels.
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const raster: PageRaster = {
    data: imageData.data,
    width: img.width,
    height: img.height,
  };
  blocks.forEach((block, i) => fits.set(i, fitBubble(raster, block)));

  // Reuse translations we already paid for when only the geometry changed.
  const previous = new Map((cached?.blocks ?? []).map((b) => [b.source, b.text]));
  const sources = blocks.map((b) => b.text);
  const known = sources.map((s) => previous.get(s));
  const missing = known.some((t) => t === undefined);

  let texts: string[];
  let provider: Provider;
  if (missing) {
    const result = await translateBlocks(sources, opts.targetLang, spec.code);
    texts = result.texts;
    provider = result.provider;
  } else {
    texts = known as string[];
    provider = cached?.provider ?? 'none';
  }

  const overlayBlocks: OverlayBlock[] = [];
  blocks.forEach((block, i) => {
    const text = (texts[i] ?? '').trim();
    if (!text) return;
    const fit = fits.get(i)!;
    const sourceLineHeight = (block.y1 - block.y0) / Math.max(1, block.lines.length);
    const layout = layoutText(text, fit.x1 - fit.x0, fit.y1 - fit.y0, script, sourceLineHeight);
    overlayBlocks.push({
      id: i,
      x0: Math.round(block.x0),
      y0: Math.round(block.y0),
      x1: Math.round(block.x1),
      y1: Math.round(block.y1),
      rx0: Math.round(fit.x0),
      ry0: Math.round(fit.y0),
      rx1: Math.round(fit.x1),
      ry1: Math.round(fit.y1),
      source: block.text,
      text,
      vertical: block.vertical,
      inBubble: fit.inBubble,
      fill: fit.fill,
      color: fit.textColor,
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight,
      lines: layout.lines,
    });
  });

  return {
    overlay: {
      ...base,
      provider,
      translated: overlayBlocks.length > 0,
      reason: overlayBlocks.length > 0 ? undefined : 'no-text',
      blocks: overlayBlocks,
    },
    fits,
  };
}

/**
 * Returns the overlay description for a page, running the pipeline on a miss.
 * This is what the reader draws as live HTML over the original scan.
 */
export async function pageOverlay(opts: TranslateOptions): Promise<PageOverlay> {
  const file = overlayPath(opts);
  const cached = readOverlay(file);
  if (cached) return cached;

  const { overlay } = await analyze(opts, null);
  writeJson(file, overlay);
  return overlay;
}

/** `rgb(r,g,b)` -> `rgba(r,g,b,alpha)`. */
function withAlpha(fill: string, alpha: number): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fill);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${alpha})` : fill;
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Draws one block onto the page canvas. */
function drawBlock(ctx: SKRSContext2D, block: OverlayBlock, script: Script): void {
  const total = block.lines.length * block.lineHeight;
  const cx = (block.rx0 + block.rx1) / 2;
  const cy = (block.ry0 + block.ry1) / 2;

  // Blocks outside a bubble were never erased, so the original lettering is
  // still underneath. A translucent plate hides it while leaving the artwork
  // legible — an outline alone just double-printed the two texts.
  if (!block.inBubble) {
    const padX = block.fontSize * 0.35;
    const padY = block.fontSize * 0.2;
    const w = Math.max(block.rx1 - block.rx0, 8) + padX * 2;
    const h = total + padY * 2;
    ctx.save();
    ctx.fillStyle = withAlpha(block.fill, 0.88);
    roundedRect(ctx, cx - w / 2, cy - h / 2, w, h, block.fontSize * 0.35);
    ctx.fill();
    ctx.restore();
  }

  ctx.font = `bold ${block.fontSize}px ${fontStack(script)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = block.color;

  let y = cy - total / 2 + block.lineHeight / 2;
  for (const line of block.lines) {
    ctx.fillText(line, cx, y);
    y += block.lineHeight;
  }
}

/**
 * Renders a page.
 *
 * `baked` erases the original lettering and paints the translation, giving a
 * self-contained flattened image. `clean` stops after the erase, so the reader
 * can lay live HTML text over it — a rectangular HTML box cannot follow the
 * curve of a speech balloon, but an erased balloon needs no box at all.
 *
 * Both variants and the overlay JSON are cached under the chapter's `.trl/`.
 */
export async function renderPage(
  opts: TranslateOptions,
  variant: RenderVariant = 'baked',
): Promise<TranslatedPage> {
  const out = imagePath(opts, variant);
  if (fs.existsSync(out)) {
    return { buffer: fs.readFileSync(out), mime: 'image/png', fromCache: true, translated: true };
  }
  const overlayFile = overlayPath(opts);
  const cachedOverlay = readOverlay(overlayFile);

  const ext = path.extname(opts.localPath).toLowerCase();
  const sourceMime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

  const { overlay, fits } = await analyze(opts, cachedOverlay);
  writeJson(overlayFile, overlay);

  if (!overlay.translated) {
    return {
      buffer: fs.readFileSync(opts.localPath),
      mime: sourceMime,
      fromCache: false,
      translated: false,
    };
  }

  const img = await loadImage(opts.localPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // Erase every bubble in one raster pass, then draw the new lettering.
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const raster: PageRaster = { data: imageData.data, width: img.width, height: img.height };
  let erased = false;
  for (const block of overlay.blocks) {
    const fit = fits.get(block.id);
    if (fit?.inBubble) {
      eraseInto(raster, fit);
      erased = true;
    }
  }
  if (erased) ctx.putImageData(imageData, 0, 0);

  if (variant === 'baked') {
    const script = targetScript(opts.targetLang);
    for (const block of overlay.blocks) drawBlock(ctx, block, script);
  }

  const buffer = canvas.toBuffer('image/png');
  try {
    fs.writeFileSync(out, buffer);
  } catch {
    /* cache is best-effort */
  }
  return { buffer, mime: 'image/png', fromCache: false, translated: true };
}

/** Flattened page with the translation drawn in. */
export function translatePage(opts: TranslateOptions): Promise<TranslatedPage> {
  return renderPage(opts, 'baked');
}

/** Look up a downloaded page's local path for a title/chapter. */
export function pageLocalPath(titleId: string, chapterId: string, pageNumber: number): string | null {
  return listPages(chapterId).find((p) => p.page_number === pageNumber)?.local_path ?? null;
}

export { listPages };

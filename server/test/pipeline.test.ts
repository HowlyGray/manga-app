/**
 * The page pipeline end to end on a synthetic page: two white balloons with
 * lettering on a dark panel. OCR comes from a cache file (no engine runs) and
 * Google's endpoint is stubbed, so every translation request is counted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataDir } from '../src/config';
import { chapterDir } from '../src/db';

const T = '11111111-2222-4333-8444-555555555555';
const C = '66666666-7777-4888-8999-000000000000';
const dir = chapterDir(T, C);
const localPath = path.join(dir, '0001.png');
const opts = { titleId: T, chapterId: C, pageNumber: 1, sourceLang: 'en', targetLang: 'FR', localPath };

/** Draws the page and writes the OCR result the pipeline will read from cache. */
async function makePage(): Promise<void> {
  const canvas = createCanvas(900, 1200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(60,60,60)';
  ctx.fillRect(0, 0, 900, 1200);
  const balloon = (cx: number, cy: number, rx: number, ry: number) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  };
  balloon(450, 300, 300, 150);
  balloon(450, 850, 260, 120);

  // Box geometry is fixed rather than measured: a CI machine may have no fonts,
  // and the pipeline only needs the boxes to sit inside their balloons.
  ctx.font = 'bold 32px sans-serif';
  ctx.fillStyle = '#000000';
  const lines = [
    { text: 'HELLO THERE', baseline: 290, width: 220 },
    { text: 'MY FRIEND', baseline: 332, width: 180 },
    { text: 'LÄ @IÚP', baseline: 862, width: 150 },
  ].map(({ text, baseline, width }) => {
    const x0 = 450 - width / 2;
    ctx.fillText(text, x0, baseline, width);
    return { text, conf: 90, x0, y0: baseline - 28, x1: x0 + width, y1: baseline + 6 };
  });

  fs.mkdirSync(path.join(dir, '.ocr'), { recursive: true });
  fs.writeFileSync(localPath, await canvas.encode('png'));
  // MANGA_OCR=0 in the test setup, so the pipeline looks for the tesseract entry.
  fs.writeFileSync(
    path.join(dir, '.ocr', '1.en.tesseract.json'),
    JSON.stringify({ engine: 'tesseract', lang: 'eng', lines }),
  );
}

let sent: string[][] = [];
/** How long the stubbed endpoint takes to answer, like a real round trip. */
let latencyMs = 0;

beforeAll(makePage);

beforeEach(() => {
  sent = [];
  latencyMs = 0;
  const guard = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://translate.googleapis.com/')) return guard(input, init);
    const q = new URL(url).searchParams.getAll('q');
    sent.push(q);
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    return new Response(JSON.stringify(q.map((t) => [`[FR] ${t}`])), {
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('page pipeline', () => {
  it('translates each bubble once and keeps its raw reading', async () => {
    const { pageOverlay } = await import('../src/services/imgtranslate');
    const overlay = await pageOverlay(opts);
    expect(overlay.v).toBe(13);
    expect(overlay.blocks.map((b) => b.source)).toEqual(['HELLO THERE MY FRIEND', 'LÄ @IÚP']);
    expect(overlay.blocks.every((b) => b.reading === b.source)).toBe(true);
    expect(overlay.blocks.every((b) => b.inBubble)).toBe(true);
    expect(overlay.blocks[1].uncertain).toBe(true);
    expect(sent).toEqual([['HELLO THERE MY FRIEND', 'LÄ @IÚP']]);
  });

  it('renders WebP from the cached overlay without translating again', async () => {
    const { isRendered, renderPage } = await import('../src/services/imgtranslate');
    for (const variant of ['baked', 'clean'] as const) {
      const page = await renderPage(opts, variant);
      expect(page.mime).toBe('image/webp');
      expect(page.buffer.subarray(8, 12).toString('ascii')).toBe('WEBP');
    }
    expect(isRendered(opts)).toBe(true);
    expect(sent).toEqual([]);
  });

  it('after a correction, a fresh process re-translates only that bubble', async () => {
    // New module instances: an empty memo, as after a server restart. Reuse can
    // only come from the overlay cached on disk.
    vi.resetModules();
    const { isRendered, pageOverlay } = await import('../src/services/imgtranslate');
    const { saveCorrection } = await import('../src/services/corrections');

    saveCorrection('en', 'LÄ @IÚP', 'LÀ GIÚP');
    const overlay = await pageOverlay(opts, { refresh: true });
    expect(sent).toEqual([['LÀ GIÚP']]);
    expect(overlay.blocks[0].text).toBe('[FR] HELLO THERE MY FRIEND');
    expect(overlay.blocks[1]).toMatchObject({ source: 'LÀ GIÚP', reading: 'LÄ @IÚP', text: '[FR] LÀ GIÚP' });
    // The flattened page showed the old text, so it is dropped for a redraw.
    expect(isRendered(opts)).toBe(false);
  });

  it('takes a second edit of the same bubble', async () => {
    const { pageOverlay } = await import('../src/services/imgtranslate');
    const { saveCorrection } = await import('../src/services/corrections');
    saveCorrection('en', 'LÄ @IÚP', 'LÀ GIÚP ĐỠ');
    const overlay = await pageOverlay(opts, { refresh: true });
    expect(overlay.blocks[1].source).toBe('LÀ GIÚP ĐỠ');
    expect(sent).toEqual([['LÀ GIÚP ĐỠ']]);
  });

  it('shares one analysis between simultaneous requests for a page', async () => {
    // A second page with the same content; fresh modules so nothing is memoized.
    fs.copyFileSync(localPath, path.join(dir, '0002.png'));
    fs.copyFileSync(path.join(dir, '.ocr', '1.en.tesseract.json'), path.join(dir, '.ocr', '2.en.tesseract.json'));
    const page2 = { ...opts, pageNumber: 2, localPath: path.join(dir, '0002.png') };
    // With an instant answer the first run fills the memo before the others ask,
    // which hides duplicate runs; a real round trip leaves them all waiting.
    latencyMs = 300;
    vi.resetModules();
    const { isRendered, pageOverlay, renderPage } = await import('../src/services/imgtranslate');

    // The text layer, its clean page and a chapter job all asking at once.
    const [overlay] = await Promise.all([
      pageOverlay(page2),
      renderPage(page2, 'clean'),
      renderPage(page2, 'baked'),
    ]);
    expect(sent).toHaveLength(1);
    expect(overlay.blocks).toHaveLength(2);
    expect(isRendered(page2)).toBe(true);
  });

  it('sweeps other versions but keeps current renders, pages and traineddata', async () => {
    const { sweepStaleTranslations } = await import('../src/services/imgtranslate');
    const trl = path.join(dir, '.trl');
    const current = fs.readdirSync(trl).sort();
    const stale = ['1.FR.png', '1.FR.v12.json', '1.FR.v11.clean.png'];
    for (const f of stale) fs.writeFileSync(path.join(trl, f), 'old');
    const legacy = path.join(dataDir, '.ocr');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '0001.jpg.jpn.json'), '[]');
    fs.writeFileSync(path.join(legacy, 'eng.traineddata'), 'model');

    const { files } = await sweepStaleTranslations();
    expect(files).toBe(stale.length + 1);
    expect(fs.readdirSync(trl).sort()).toEqual(current);
    expect(fs.existsSync(path.join(legacy, 'eng.traineddata'))).toBe(true);
    expect(fs.existsSync(localPath)).toBe(true);
  });
});

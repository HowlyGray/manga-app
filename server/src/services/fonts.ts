/**
 * Font registration for baked page rendering.
 *
 * `@napi-rs/canvas` ships no fonts: asking for `sans-serif` on Windows silently
 * resolved to a serif face, which is why redrawn bubbles looked nothing like
 * lettering. We register a real face up front and hand callers a family stack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import type { Script } from './lang';

const LATIN_ALIAS = 'MangaText';
const CJK_ALIAS = 'MangaTextCJK';

/** Comic-ish bold faces first, then any legible bold sans. */
const LATIN_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:/Windows/Fonts/comicbd.ttf',
    'C:/Windows/Fonts/ARIALNB.TTF',
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/calibrib.ttf',
  ],
  darwin: [
    '/Library/Fonts/Comic Sans MS Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ],
  linux: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  ],
};

const CJK_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:/Windows/Fonts/YuGothB.ttc',
    'C:/Windows/Fonts/meiryob.ttc',
    'C:/Windows/Fonts/msgothic.ttc',
    'C:/Windows/Fonts/msyhbd.ttc',
    'C:/Windows/Fonts/malgunbd.ttf',
  ],
  darwin: [
    '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
  ],
  linux: [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ],
};

/** Drop a .ttf/.otf here to override the bundled choice without env vars. */
const assetsDir = path.resolve(import.meta.dirname, '..', '..', 'assets', 'fonts');

function assetFonts(): string[] {
  try {
    return fs
      .readdirSync(assetsDir)
      .filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
      .sort()
      .map((f) => path.join(assetsDir, f));
  } catch {
    return [];
  }
}

function registerFirst(candidates: string[], alias: string): string | null {
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      if (GlobalFonts.registerFromPath(file, alias)) return file;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

let initialized = false;
let latinReady = false;
let cjkReady = false;

/** Registers the render fonts once; safe to call from anywhere. */
export function initFonts(): void {
  if (initialized) return;
  initialized = true;

  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  const envLatin = (process.env.TRANSLATE_FONT ?? '').trim();
  const envCjk = (process.env.TRANSLATE_FONT_CJK ?? '').trim();

  const latin = registerFirst(
    [envLatin, ...assetFonts(), ...(LATIN_CANDIDATES[platform] ?? [])].filter(Boolean),
    LATIN_ALIAS,
  );
  latinReady = latin != null;

  const cjk = registerFirst([envCjk, ...(CJK_CANDIDATES[platform] ?? [])].filter(Boolean), CJK_ALIAS);
  cjkReady = cjk != null;

  if (latin) console.log(`[fonts] page text: ${path.basename(latin)}`);
  else console.warn('[fonts] no bold sans found; baked pages fall back to the system default');
  if (cjk) console.log(`[fonts] CJK targets: ${path.basename(cjk)}`);
}

/**
 * CSS-style family stack for `ctx.font`. CJK targets lead with the CJK face so
 * kana/hanzi resolve; everything else leads with the Latin face.
 */
export function fontStack(script: Script): string {
  initFonts();
  const latin = latinReady ? `"${LATIN_ALIAS}"` : null;
  const cjk = cjkReady ? `"${CJK_ALIAS}"` : null;
  const order = script === 'jpn' || script === 'cjk' ? [cjk, latin] : [latin, cjk];
  return [...order.filter(Boolean), 'sans-serif'].join(', ');
}

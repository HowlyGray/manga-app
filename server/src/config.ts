import path from 'node:path';
import fs from 'node:fs';

const serverDir = import.meta.dirname;
const appRoot = path.resolve(serverDir, '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 5180),
  // Bind every interface so phones and tablets on the same network can reach
  // the app. Set HOST=127.0.0.1 to keep it to this machine.
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(appRoot, 'data'),
  libraryDir: process.env.LIBRARY_DIR
    ? path.resolve(process.env.LIBRARY_DIR)
    : path.join(appRoot, 'library'),
  mangadex: {
    userAgent:
      'manga-app/0.1.0 (personal offline library / reader; no ads; MangaDex credited)',
    apiIntervalMs: Number(process.env.MDX_API_MS ?? 260),
    imageIntervalMs: Number(process.env.MDX_IMAGE_MS ?? 120),
    imageConcurrency: Number(process.env.MDX_IMAGE_CONCURRENCY ?? 3),
    quality: (process.env.MDX_QUALITY ?? 'original') as 'original' | 'data-saver',
  },
  jikan: {
    apiIntervalMs: Number(process.env.JIKAN_API_MS ?? 380),
  },
  cache: {
    // Title metadata barely changes; chapter indexes gain entries constantly.
    titleMs: Number(process.env.CACHE_TITLE_MS ?? 7 * 24 * 3600_000),
    chaptersMs: Number(process.env.CACHE_CHAPTERS_MS ?? 3600_000),
    // Covers are immutable in practice, so they are kept until deleted.
    coverConcurrency: Number(process.env.CACHE_COVER_CONCURRENCY ?? 6),
    // Page URLs of a previewed chapter; MangaDex's expire, so keep it short.
    pagesMs: Number(process.env.CACHE_PAGES_MS ?? 10 * 60_000),
  },
  weebcentral: {
    // Secondary source, used mostly for series MangaDex no longer carries.
    enabled: (process.env.WEEBCENTRAL ?? '1') !== '0',
    intervalMs: Number(process.env.WEEBCENTRAL_MS ?? 700),
  },
  translate: {
    // DeepL — set DEEPL_API_KEY (free keys typically end in ':fx').
    deeplApiKey: process.env.DEEPL_API_KEY ?? undefined,
    deeplUrl: process.env.DEEPL_API_URL
      ? process.env.DEEPL_API_URL.replace(/\/$/, '')
      : undefined,
    // Optional context-aware provider: translates a whole page in one call.
    llm: {
      enabled: (process.env.TRANSLATE_LLM ?? '1') !== '0',
      apiKey: process.env.ANTHROPIC_API_KEY ?? undefined,
      model: process.env.TRANSLATE_LLM_MODEL ?? 'claude-opus-5',
      // Bubble translation is a short, well-specified task; low effort keeps
      // whole-chapter runs affordable without hurting the result.
      effort: (process.env.TRANSLATE_LLM_EFFORT ?? 'low') as 'low' | 'medium' | 'high',
    },
    // Preferred chapter languages, best first. Only affects which translation
    // of a chapter gets picked when several exist; anything unlisted falls back
    // to how well the OCR chain reads it (see services/lang.ts).
    chapterLanguages: (process.env.DOWNLOAD_LANGS ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    // Fallback source language, used only when a chapter has no language set.
    // (The chapter's own language is what drives OCR — see services/lang.ts.)
    defaultSource: process.env.TRANSLATE_SRC ?? 'ja',
    // Drop OCR lines below this confidence (0-100) before grouping.
    minConfidence: Number(process.env.TRANSLATE_MIN_CONF ?? 55),
    // Re-read each detected balloon as one block to recover dropped lines.
    refine: (process.env.TRANSLATE_REFINE ?? '1') !== '0',
    // Below this confidence a reading is marked unreliable in the reader rather
    // than presented as if it were sound. Tesseract scores manga lettering low
    // across the board, so this is a floor for the genuinely bad, not a median.
    uncertainConfidence: Number(process.env.TRANSLATE_UNCERTAIN_CONF ?? 35),
    // Manga-OCR (Python sidecar) — set MANGA_OCR=0 to disable.
    mangaOcr: {
      enabled: (process.env.MANGA_OCR ?? '1') !== '0',
      python: (process.env.MANGA_OCR_PYTHON ?? '').trim() || undefined,
      // Lazy-resolved absolute path (see mangaPython() in services).
      base: serverDir,
      // The sidecar stays resident between pages; these bound its lifecycle.
      bootMs: Number(process.env.MANGA_OCR_BOOT_MS ?? 600000),
      // Text-detection sensitivity. Lower thresholds find thin, low-contrast
      // and outlined lettering that the stock RapidOCR settings skip.
      detect: {
        thresh: Number(process.env.TRANSLATE_DET_THRESH ?? 0.15),
        boxThresh: Number(process.env.TRANSLATE_DET_BOX_THRESH ?? 0.25),
        unclipRatio: Number(process.env.TRANSLATE_DET_UNCLIP ?? 1.8),
        sideLen: Number(process.env.TRANSLATE_DET_SIDE ?? 1280),
      },
      requestMs: Number(process.env.MANGA_OCR_REQUEST_MS ?? 180000),
      idleMs: Number(process.env.MANGA_OCR_IDLE_MS ?? 300000),
    },
    // Target languages offered in the reader (DeepL target codes).
    targets: [
      'EN', 'FR', 'DE', 'ES', 'PT-BR', 'IT', 'NL', 'PL', 'RU', 'KO', 'JA', 'ZH-HANS', 'ZH-HANT', 'TR', 'ID',
    ],
  },
};

export const dbPath = path.join(config.dataDir, 'library.db');
export const coverDir = path.join(config.libraryDir, 'covers');
/** Covers of titles that are only browsed, not saved to the library. */
export const coverCacheDir = path.join(coverDir, 'cache');
export const dataDir = path.join(config.libraryDir, 'data');

export function ensureDirs(): void {
  for (const dir of [config.dataDir, coverDir, coverCacheDir, dataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

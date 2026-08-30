import path from 'node:path';
import fs from 'node:fs';

const serverDir = import.meta.dirname;
const appRoot = path.resolve(serverDir, '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 5180),
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
  translate: {
    // DeepL — set DEEPL_API_KEY (free keys typically end in ':fx').
    deeplApiKey: process.env.DEEPL_API_KEY ?? undefined,
    deeplUrl: process.env.DEEPL_API_URL
      ? process.env.DEEPL_API_URL.replace(/\/$/, '')
      : undefined,
    // Source language assumed when translating page text (tesseract lang code).
    ocrSource: process.env.TRANSLATE_SRC ?? 'jpn',
    // Manga-OCR (Python sidecar) — set MANGA_OCR=0 to disable.
    mangaOcr: {
      enabled: (process.env.MANGA_OCR ?? '1') !== '0',
      python: (process.env.MANGA_OCR_PYTHON ?? '').trim() || undefined,
      // Lazy-resolved absolute path (see mangaPython() in services).
      base: serverDir,
    },
    // Target languages offered in the reader (DeepL target codes).
    targets: [
      'EN', 'FR', 'DE', 'ES', 'PT-BR', 'IT', 'NL', 'PL', 'RU', 'KO', 'JA', 'ZH-HANS', 'ZH-HANT', 'TR', 'ID',
    ],
  },
};

export const dbPath = path.join(config.dataDir, 'library.db');
export const coverDir = path.join(config.libraryDir, 'covers');
export const dataDir = path.join(config.libraryDir, 'data');

export function ensureDirs(): void {
  for (const dir of [config.dataDir, coverDir, dataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
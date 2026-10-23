/**
 * Runs before every test file. Points the app at a throwaway library and
 * database, turns off everything that would reach outside the process (the
 * Python OCR sidecar, tesseract's re-read pass and its traineddata download,
 * Claude, DeepL), and makes any stray network request fail loudly.
 *
 * Config is read when modules are first imported, so this has to run before
 * the test file loads anything from src/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-app-test-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.LIBRARY_DIR = path.join(root, 'library');
process.env.MANGA_OCR = '0';
process.env.TRANSLATE_REFINE = '0';
process.env.TRANSLATE_LLM = '0';
process.env.DEEPL_API_KEY = '';
// Nothing real is being rate-limited, so the courtesy delays only slow tests down.
process.env.MDX_API_MS = '0';
process.env.JIKAN_API_MS = '0';
for (const name of ['ANTHROPIC_API_KEY', 'HOST', 'ALLOWED_HOSTS', 'DOWNLOAD_LANGS', 'TRANSLATE_SRC']) {
  delete process.env[name];
}

// Tests may talk to servers they started on loopback, and stub `fetch` for
// anything else they expect; every other request is a bug.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  return Promise.reject(new Error(`unexpected network request in a test: ${url}`));
}) as typeof fetch;

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* an open database file can hold it on Windows; the OS temp dir cleans up */
  }
});

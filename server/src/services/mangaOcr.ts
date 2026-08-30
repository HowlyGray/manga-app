import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface MangaOcrLine {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Resolve the Python interpreter used to run the manga-OCR worker. */
export function mangaPython(): string | null {
  const explicit = config.translate.mangaOcr.python;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const venvDir = path.join(config.translate.mangaOcr.base, '..', '.venv-mangaocr');
  const candidates =
    process.platform === 'win32'
      ? [path.join(venvDir, 'Scripts', 'python.exe'), path.join(venvDir, 'python.exe')]
      : [path.join(venvDir, 'bin', 'python3'), path.join(venvDir, 'bin', 'python')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to any python on PATH if a venv wasn't created — the worker
  // imports will still fail if manga-ocr-torchless isn't installed there.
  return process.platform === 'win32' ? 'python' : 'python3';
}

const workerPath = path.resolve(config.translate.mangaOcr.base, 'python', 'manga_ocr_worker.py');

let readyCheck: boolean | null = null;

/** Returns true if the manga-OCR Python environment appears usable. */
export function isMangaOcrAvailable(): boolean {
  if (!config.translate.mangaOcr.enabled) return false;
  const py = mangaPython();
  if (!py) return false;
  // Skip env probing on every request; cache only the negative (positive still
  // gets re-verified per call so a broken env falls back gracefully).
  if (readyCheck === false) return false;
  if (readyCheck === true && fs.existsSync(workerPath)) return true;
  readyCheck = fs.existsSync(workerPath) && (py === 'python' || fs.existsSync(py));
  return readyCheck === true;
}

interface OcrRequest {
  image: string;
}

/**
 * Detects and recognizes Japanese text on a page via the Python sidecar
 * (RapidOCR detection + manga-ocr recognition). Returns null on any failure so
 * callers can fall back to tesseract.
 */
export async function mangaOcrPage(filePath: string): Promise<MangaOcrLine[] | null> {
  const py = mangaPython();
  if (!py || !isMangaOcrAvailable()) return null;

  const req: OcrRequest = { image: filePath };
  return new Promise((resolve) => {
    const child = spawn(py, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 120000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          resolve(null);
          return;
        }
        resolve(parsed as MangaOcrLine[]);
      } catch {
        resolve(null);
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}
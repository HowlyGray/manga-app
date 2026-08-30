import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/** `manga` detects and recognizes Japanese; `detect` returns boxes only. */
export type SidecarMode = 'manga' | 'detect';

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

interface Pending {
  resolve: (lines: MangaOcrLine[] | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Long-lived sidecar. The recognition model is ~400 MB and takes seconds to
 * load, so the worker stays resident between pages and is only torn down after
 * an idle period.
 */
class MangaOcrWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private buffer = '';
  private queue: Pending[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  private settle(lines: MangaOcrLine[] | null): void {
    const pending = this.queue.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(lines);
  }

  private teardown(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.buffer = '';
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    while (this.queue.length > 0) this.settle(null);
    child?.kill();
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queue.length === 0) this.teardown();
    }, config.translate.mangaOcr.idleMs);
    this.idleTimer.unref?.();
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const reply = parsed as { ready?: boolean; error?: string; lines?: MangaOcrLine[] };
    if (reply.ready) return; // handled by the readiness promise
    if (reply.error) {
      console.error(`[ocr] manga-ocr worker: ${reply.error}`);
      this.settle(null);
      return;
    }
    this.settle(Array.isArray(reply.lines) ? reply.lines : null);
  }

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;

    this.ready = new Promise<boolean>((resolve) => {
      const py = mangaPython();
      if (!py) {
        resolve(false);
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(py, [workerPath, '--serve'], { stdio: 'pipe', windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      this.child = child;

      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      // First run downloads the ONNX model from Hugging Face; be generous.
      const bootTimer = setTimeout(() => {
        if (!settled) {
          console.error('[ocr] manga-ocr worker did not become ready in time');
          this.teardown();
          finish(false);
        }
      }, config.translate.mangaOcr.bootMs);
      bootTimer.unref?.();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl = this.buffer.indexOf('\n');
        while (nl >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) {
            if (!settled) {
              clearTimeout(bootTimer);
              // A first line that is not `ready` means startup already failed.
              const ok = line.includes('"ready"');
              if (!ok) console.error(`[ocr] manga-ocr worker failed to start: ${line.slice(0, 300)}`);
              finish(ok);
              if (!ok) this.teardown();
            } else {
              this.handleLine(line);
            }
          }
          nl = this.buffer.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) console.error(`[ocr] manga-ocr: ${text.slice(0, 500)}`);
      });
      child.on('error', () => {
        clearTimeout(bootTimer);
        this.teardown();
        finish(false);
      });
      child.on('close', () => {
        clearTimeout(bootTimer);
        this.teardown();
        finish(false);
      });
    });

    return this.ready;
  }

  async run(filePath: string, mode: SidecarMode): Promise<MangaOcrLine[] | null> {
    const ok = await this.start();
    const child = this.child;
    if (!ok || !child) return null;

    return new Promise<MangaOcrLine[] | null>((resolve) => {
      const timer = setTimeout(() => {
        console.error('[ocr] manga-ocr request timed out; restarting the worker');
        this.teardown();
        resolve(null);
      }, config.translate.mangaOcr.requestMs);
      timer.unref?.();
      this.queue.push({ resolve, timer });
      const tuning = config.translate.mangaOcr.detect;
      const request = {
        image: filePath,
        mode,
        detect: {
          thresh: tuning.thresh,
          box_thresh: tuning.boxThresh,
          unclip_ratio: tuning.unclipRatio,
          side_len: tuning.sideLen,
        },
      };
      child.stdin.write(`${JSON.stringify(request)}\n`);
      this.touchIdleTimer();
    });
  }
}

const worker = new MangaOcrWorker();

/**
 * Detects and recognizes Japanese text on a page via the Python sidecar
 * (RapidOCR detection + manga-ocr recognition). Returns null on any failure so
 * callers can fall back to tesseract.
 */
export async function mangaOcrPage(filePath: string): Promise<MangaOcrLine[] | null> {
  if (!isMangaOcrAvailable()) return null;
  return worker.run(filePath, 'manga');
}

/**
 * Text-region detection only, for pages in any script. RapidOCR's detector is
 * script-agnostic, so this gives tight per-line boxes on Georgian or Hebrew
 * scans too — far better than letting tesseract lay out a comic page, which
 * merges text across panel borders. `text` comes back empty; the caller
 * recognizes each crop itself.
 */
export async function detectTextBoxes(filePath: string): Promise<MangaOcrLine[] | null> {
  if (!isMangaOcrAvailable()) return null;
  return worker.run(filePath, 'detect');
}

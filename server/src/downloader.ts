import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { chapterDir } from './db';
import { getProvider } from './sources';
import {
  getChapter,
  markPageDownloaded,
  replaceChapterPages,
  setChapterDownloaded,
} from './services/library';
import { RateLimiter } from './util/net';

const imageLimiter = new RateLimiter(config.mangadex.imageIntervalMs);

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export interface DownloadResult {
  ok: boolean;
  downloaded: number;
  failed: number;
}

/**
 * Downloads every page image of a chapter into library/data/{titleId}/{chapterId}
 * and updates the DB (pages + downloaded flag).
 */
export async function downloadChapter(
  titleId: string,
  chapterId: string,
): Promise<DownloadResult> {
  const ch = getChapter(titleId, chapterId);
  if (!ch) throw new Error(`chapter ${chapterId} not found in library`);

  const provider = getProvider(ch.provider);
  const images = await provider.chapterPages(ch.provider_id);
  if (images.length === 0) {
    setChapterDownloaded(chapterId, 1, null);
    return { ok: true, downloaded: 0, failed: 0 };
  }

  // The page list is stored by file name so a partial download can resume.
  const names = images.map((img, i) => path.basename(new URL(img.url).pathname) || `${i + 1}`);
  replaceChapterPages(chapterId, images.length, names);

  const dir = chapterDir(titleId, chapterId);
  fs.mkdirSync(dir, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  const errors: string[] = [];

  await mapLimit(images, config.mangadex.imageConcurrency, async (image, index) => {
    const pageNumber = index + 1;
    const ext = path.extname(names[index]) || '.jpg';
    const localPath = path.join(dir, `${String(pageNumber).padStart(4, '0')}${ext}`);
    try {
      await imageLimiter.run(async () => {
        const res = await provider.fetchImage(image);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buf);
        const sizeHeader = Number(res.headers.get('content-length') ?? NaN);
        markPageDownloaded(chapterId, pageNumber, localPath, Number.isFinite(sizeHeader) ? sizeHeader : buf.length);
      });
      downloaded++;
    } catch (err) {
      failed++;
      errors.push(`${names[index]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (failed === 0) {
    setChapterDownloaded(chapterId, 1, null);
    return { ok: true, downloaded, failed };
  }
  setChapterDownloaded(chapterId, -1, errors.slice(0, 5).join('; '));
  return { ok: false, downloaded, failed };
}
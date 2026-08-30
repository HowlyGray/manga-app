import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { chapterDir } from './db';
import { downloadImage, getAtHomeServer } from './api/mangadex';
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

  const atHome = await getAtHomeServer(ch.provider_id);
  if (!atHome) throw new Error('unable to reach at-home server for chapter');

  const useSaver = config.mangadex.quality === 'data-saver';
  const files = useSaver ? atHome.dataSaverFiles : atHome.files;
  if (files.length === 0) {
    setChapterDownloaded(chapterId, 1, null);
    return { ok: true, downloaded: 0, failed: 0 };
  }

  replaceChapterPages(chapterId, files.length, files);

  const dir = chapterDir(titleId, chapterId);
  fs.mkdirSync(dir, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  const errors: string[] = [];

  await mapLimit(files, config.mangadex.imageConcurrency, async (file, index) => {
    const pageNumber = index + 1;
    const ext = path.extname(file) || '.jpg';
    const localPath = path.join(dir, `${String(pageNumber).padStart(4, '0')}${ext}`);
    try {
      await imageLimiter.run(async () => {
        const url = `${atHome.baseUrl}/data/${atHome.hash}${useSaver ? '/data-saver' : ''}/${file}`;
        const res = await downloadImage(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localPath, buf);
        const sizeHeader = Number(res.headers.get('content-length') ?? NaN);
        markPageDownloaded(chapterId, pageNumber, localPath, Number.isFinite(sizeHeader) ? sizeHeader : buf.length);
      });
      downloaded++;
    } catch (err) {
      failed++;
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (failed === 0) {
    setChapterDownloaded(chapterId, 1, null);
    return { ok: true, downloaded, failed };
  }
  setChapterDownloaded(chapterId, -1, errors.slice(0, 5).join('; '));
  return { ok: false, downloaded, failed };
}
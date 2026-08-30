import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { chapterDir } from '../db';
import { getChapter, listPages } from './library';
import { translatePage } from './imgtranslate';

export interface ChapterTranslateJob {
  key: string;
  titleId: string;
  chapterId: string;
  target: string;
  running: boolean;
  total: number;
  done: number;
  failed: number;
  pages: { pageNumber: number; status: 'ok' | 'error' | 'skipped' }[];
  error?: string;
}

const jobs = new Map<string, ChapterTranslateJob>();

function jobKey(titleId: string, chapterId: string, target: string): string {
  return `${titleId}/${chapterId}/${target}`;
}

function sanitizeTarget(target: string): string | null {
  const t = (target ?? '').toUpperCase();
  return config.translate.targets.includes(t) ? t : null;
}

/** Returns null if the job is already running, else starts it. */
export function startChapterTranslate(titleId: string, chapterId: string, targetLang: string): ChapterTranslateJob {
  const key = jobKey(titleId, chapterId, targetLang);
  const existing = jobs.get(key);
  if (existing && existing.running) return existing;

  const pages = listPages(chapterId).filter((p) => p.downloaded === 1 && p.local_path);
  // OCR must follow the language actually printed on the page: that is the
  // chapter's language, not the title's original language.
  const sourceLang = getChapter(titleId, chapterId)?.language ?? config.translate.defaultSource;
  const job: ChapterTranslateJob = {
    key,
    titleId,
    chapterId,
    target: targetLang,
    running: true,
    total: pages.length,
    done: 0,
    failed: 0,
    pages: pages.map((p) => ({ pageNumber: p.page_number, status: 'skipped' as const })),
  };
  jobs.set(key, job);

  runJob(job, sourceLang, pages.map((p) => ({ pageNumber: p.page_number, localPath: p.local_path! })))
    .catch((err: unknown) => {
      job.error = err instanceof Error ? err.message : String(err);
      job.running = false;
    })
    .finally(() => {
      // Keep the last job result around so the UI can render completion.
      setTimeout(() => jobs.delete(key), 5 * 60 * 1000);
    });

  return job;
}

async function runJob(
  job: ChapterTranslateJob,
  sourceLang: string,
  pages: { pageNumber: number; localPath: string }[],
): Promise<void> {
  for (const page of pages) {
    // A page already translated+redrawn for this target short-circuits in
    // translatePage(); count it as done without re-doing OCR.
    const trlPath = path.join(jobKeyDir(job), `${page.pageNumber}.${job.target}.png`);
    if (fs.existsSync(trlPath)) {
      job.pages.find((p) => p.pageNumber === page.pageNumber)!.status = 'ok';
      job.done += 1;
      continue;
    }

    try {
      await translatePage({
        titleId: job.titleId,
        chapterId: job.chapterId,
        pageNumber: page.pageNumber,
        sourceLang,
        targetLang: job.target,
        localPath: page.localPath,
      });
      job.pages.find((p) => p.pageNumber === page.pageNumber)!.status = 'ok';
      job.done += 1;
    } catch {
      job.pages.find((p) => p.pageNumber === page.pageNumber)!.status = 'error';
      job.failed += 1;
    }
    // Let the UI poll by a reasonable margin.
    await new Promise((r) => setTimeout(r, 0));
  }
  job.running = false;
}

function jobKeyDir(job: ChapterTranslateJob): string {
  return path.join(chapterDir(job.titleId, job.chapterId), '.trl');
}

export function getChapterTranslateStatus(titleId: string, chapterId: string, targetLang: string): ChapterTranslateJob | null {
  return jobs.get(jobKey(titleId, chapterId, targetLang)) ?? null;
}

export { sanitizeTarget };
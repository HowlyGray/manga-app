/**
 * What the library takes on disk, and giving it back.
 *
 * Nothing could be removed before: no title, no chapter, no translation cache,
 * on a library that reached 1.8 GB with 600 MB of that in translation renders.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { coverDir, dataDir } from '../config';
import { chapterDir, pathSegment } from '../db';
import * as lib from './library';

/** Bytes on disk for one title, by kind. */
export interface Usage {
  /** Downloaded page images. */
  pages: number;
  /** Translated renders and their layouts (`.trl`). */
  translations: number;
  /** OCR results (`.ocr`), cheap to keep and slow to redo. */
  ocr: number;
}

const EMPTY: Usage = { pages: 0, translations: 0, ocr: 0 };

function titleDir(titleId: string): string {
  return path.join(dataDir, pathSegment(titleId));
}

/** Walks a title or chapter folder, sorting file sizes by what they are. */
async function measure(dir: string): Promise<Usage> {
  const usage = { ...EMPTY };
  const walk = async (current: string, kind: keyof Usage) => {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, entry.name === '.trl' ? 'translations' : entry.name === '.ocr' ? 'ocr' : kind);
      } else if (entry.isFile()) {
        usage[kind] += (await fsp.stat(full)).size;
      }
    }
  };
  await walk(dir, 'pages');
  return usage;
}

const total = (u: Usage) => u.pages + u.translations + u.ocr;

export function titleUsage(titleId: string): Promise<Usage> {
  return measure(titleDir(titleId));
}

/** Disk use of every saved title, and the sum. */
export async function libraryUsage(): Promise<{ titles: ({ id: string } & Usage)[]; total: Usage }> {
  const titles: ({ id: string } & Usage)[] = [];
  const sum = { ...EMPTY };
  for (const t of lib.listLibrary()) {
    const usage = await titleUsage(t.id);
    titles.push({ id: t.id, ...usage });
    sum.pages += usage.pages;
    sum.translations += usage.translations;
    sum.ocr += usage.ocr;
  }
  return { titles, total: sum };
}

/**
 * Removes a title from the library: its folder (pages and caches), its saved
 * cover, its rows, and what was recorded about reading it. Returns bytes freed.
 */
export async function removeTitle(titleId: string): Promise<number> {
  const title = lib.getTitle(titleId);
  if (!title) return 0;
  const dir = titleDir(titleId);
  const freed = total(await measure(dir));
  await fsp.rm(dir, { recursive: true, force: true });
  // Only ever a file inside the cover folder, whatever the row says.
  if (title.cover_local && path.resolve(title.cover_local).startsWith(path.resolve(coverDir) + path.sep)) {
    await fsp.rm(title.cover_local, { force: true });
  }
  lib.deleteTitle(titleId);
  return freed;
}

/**
 * Deletes a chapter's downloaded pages and its caches. The chapter stays in the
 * list, ready to download again. Returns bytes freed.
 */
export async function removeChapterFiles(titleId: string, chapterId: string): Promise<number> {
  const dir = chapterDir(titleId, chapterId);
  const freed = total(await measure(dir));
  await fsp.rm(dir, { recursive: true, force: true });
  lib.forgetChapterFiles(chapterId);
  return freed;
}

/**
 * Deletes a title's translated renders. They are regenerated on demand, reusing
 * the OCR results that are kept. Returns bytes freed.
 */
export async function clearTranslations(titleId: string): Promise<number> {
  let freed = 0;
  const dir = titleDir(titleId);
  let chapters;
  try {
    chapters = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of chapters) {
    if (!entry.isDirectory()) continue;
    const trl = path.join(dir, entry.name, '.trl');
    freed += total(await measure(trl));
    await fsp.rm(trl, { recursive: true, force: true });
  }
  return freed;
}

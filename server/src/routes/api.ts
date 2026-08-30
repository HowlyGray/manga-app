import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { coverDir, config } from '../config';
import * as ingest from '../services/ingest';
import * as lib from '../services/library';
import * as imgtranslator from '../services/imgtranslate';
import { isLlmConfigured } from '../services/translator';
import { langSpec } from '../services/lang';
import { downloadChapter } from '../downloader';
import { getChapterTranslateStatus, startChapterTranslate } from '../services/chapterTranslate';

export const apiRouter = Router();

const runningTitleDownloads = new Set<string>();
const runningChapterDownloads = new Set<string>();

const LANGS = ['ja', 'ko', 'zh', 'en', 'ru', 'fr'];

function contentType(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

apiRouter.get('/ping', (_req, res) => {
  res.json({ status: 'ok' });
});

apiRouter.get('/discover', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const lang = typeof req.query.lang === 'string' && LANGS.includes(req.query.lang) ? req.query.lang : undefined;
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 24) || 24));
  const { titles, total } = await ingest.discover({ q, lang, limit, offset: (page - 1) * limit });
  res.json({
    total,
    page,
    limit,
    titles: titles.map((t) => ({
      id: t.id,
      title: ingest.mainTitle(t),
      altTitles: t.altTitles.slice(0, 5),
      originalLanguage: t.originalLanguage,
      year: t.year,
      status: t.status,
      tags: t.tags.map((tg) => tg.name).slice(0, 6),
      coverUrl: t.coverUrl,
      isSaved: lib.getTitle(t.id) != null,
    })),
  });
});

apiRouter.get('/library', (_req, res) => {
  res.json(lib.listLibrary());
});

apiRouter.get('/library/:id', async (req, res) => {
  const { id } = req.params;
  const title = lib.getTitle(id);

  // Title not in library yet: browse it from MangaDex without importing.
  if (!title) {
    try {
      const remote = await ingest.remoteTitleDetail(id);
      return res.json({
        inLibrary: false,
        coverUrl: remote.coverUrl,
        title: {
          id: remote.id,
          provider: 'mangadex',
          provider_id: remote.id,
          title: remote.title,
          alt_titles: remote.altTitles,
          original_lang: remote.originalLang,
          synopsis: remote.synopsis,
          status: remote.status,
          year: remote.year,
          author: remote.author,
          content_rating: remote.contentRating,
          tags: remote.tags,
          jikan_score: null,
        },
        languages: remote.languages,
        chapters: {
          total: remote.chapters.total,
          items: remote.chapters.items.map((c) => ({
            id: c.id,
            chapter: c.chapter,
            title: c.title,
            volume: c.volume,
            language: c.language,
            pages: c.pages,
            scanlator: c.scanlator,
            publishedAt: c.publishedAt,
            downloaded: 0,
            downloadError: null,
          })),
        },
        progress: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(404).json({ error: message });
    }
  }

  const chapters = lib.listChapters(id, 'asc').map((c) => ({
    id: c.id,
    chapter: c.chapter_number,
    title: c.chapter_title,
    volume: c.volume,
    language: c.language,
    pages: c.pages,
    scanlator: c.scanlator,
    publishedAt: c.published_at,
    downloaded: c.downloaded,
    downloadError: c.download_error,
  }));
  const progress = lib.getProgress(id);
  res.json({
    inLibrary: true,
    coverUrl: title.cover_local ? `/api/library/${id}/cover` : null,
    title: {
      id: title.id,
      provider: title.provider,
      provider_id: title.provider_id,
      title: title.title,
      alt_titles: title.alt_titles,
      original_lang: title.original_lang,
      synopsis: title.synopsis,
      status: title.status,
      year: title.year,
      author: title.author,
      content_rating: title.content_rating,
      tags: title.tags,
      jikan_score: title.jikan_score,
    },
    languages: lib.listLanguages(id),
    chapters: { total: chapters.length, items: chapters },
    progress,
  });
});

apiRouter.post('/library/import', async (req, res) => {
  const { mangadexId } = req.body ?? {};
  if (!mangadexId || typeof mangadexId !== 'string') {
    return res.status(400).json({ error: 'mangadexId required' });
  }
  try {
    const result = await ingest.importTitle(mangadexId);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import ${mangadexId}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

apiRouter.get('/library/:id/download', (req, res) => {
  const { id } = req.params;
  const chapters = lib.listChapters(id);
  res.json({
    running: runningTitleDownloads.has(id),
    total: chapters.length,
    downloaded: chapters.filter((c) => c.downloaded === 1).length,
    failed: chapters.filter((c) => c.downloaded === -1).length,
    pending: chapters.filter((c) => c.downloaded === 0).length,
  });
});

apiRouter.post('/library/:id/download', async (req, res) => {
  const { id } = req.params;
  if (!lib.getTitle(id)) {
    // Auto-import so "download all" works for titles not yet in the library.
    try {
      await ingest.importTitle(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[import ${id}] FAILED: ${message}`);
      return res.status(502).json({ error: message });
    }
  }
  if (runningTitleDownloads.has(id)) return res.json({ started: false, message: 'already running' });

  runningTitleDownloads.add(id);
  ingest
    .downloadTitle(id, (c) => {
      console.log(`  [${c.index}/${c.total}] ${c.chapterId} -> downloaded=${c.downloaded} failed=${c.failed}`);
    })
    .catch((err) => console.error('download failed:', err))
    .finally(() => runningTitleDownloads.delete(id));

  res.json({ started: true });
});

apiRouter.get('/library/:id/chapters/:chapterId', (req, res) => {
  const { id, chapterId } = req.params;
  const ch = lib.getChapter(id, chapterId);
  if (!ch) return res.status(404).json({ error: 'chapter not found' });
  const pages = lib.listPages(chapterId).map((p) => ({
    pageNumber: p.page_number,
    downloaded: p.downloaded,
    url: `/api/library/data/${id}/${chapterId}/${p.page_number}`,
  }));
  res.json({
    chapter: {
      id: ch.id,
      chapter: ch.chapter_number,
      title: ch.chapter_title,
      volume: ch.volume,
      language: ch.language,
      // Human-readable name of the language actually printed on these pages;
      // the reader uses it to label the translation controls.
      languageLabel: langSpec(ch.language).label,
      pages: ch.pages,
      scanlator: ch.scanlator,
      publishedAt: ch.published_at,
      downloaded: ch.downloaded,
      downloadError: ch.download_error,
      downloading: runningChapterDownloads.has(ch.id),
    },
    pages,
  });
});

apiRouter.post('/library/:id/chapters/:chapterId/download', async (req, res) => {
  const { id, chapterId } = req.params;
  if (!lib.getChapter(id, chapterId)) {
    // Title not in library yet -> importing it also creates the chapter row.
    if (!lib.getTitle(id)) {
      try {
        await ingest.importTitle(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[import ${id}] FAILED: ${message}`);
        return res.status(502).json({ error: message });
      }
    }
  }
  if (runningChapterDownloads.has(chapterId)) {
    return res.json({ started: false, message: 'already downloading' });
  }
  runningChapterDownloads.add(chapterId);
  downloadChapter(id, chapterId)
    .catch((err) => console.error(`chapter ${chapterId} failed:`, err))
    .finally(() => runningChapterDownloads.delete(chapterId));
  res.json({ started: true });
});

apiRouter.get('/library/:id/cover', (req, res) => {
  const { id } = req.params;
  const title = lib.getTitle(id);
  if (!title?.cover_local || !fs.existsSync(title.cover_local)) {
    return res.status(404).json({ error: 'no cover' });
  }
  res.setHeader('Content-Type', contentType(title.cover_local));
  res.sendFile(path.resolve(title.cover_local));
});

apiRouter.get('/library/data/:titleId/:chapterId/:pageNumber', (req, res) => {
  const { titleId, chapterId } = req.params;
  const pageNumber = Number(req.params.pageNumber);
  const page = lib.listPages(chapterId).find((p) => p.page_number === pageNumber);
  if (!page?.local_path || !fs.existsSync(page.local_path)) {
    return res.status(404).json({ error: 'page not downloaded' });
  }
  const filePath = path.resolve(page.local_path);
  res.setHeader('Content-Type', contentType(filePath));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(filePath);
});

/**
 * The language to OCR a page as is the chapter's own language. Using the
 * title's `original_lang` meant Japanese OCR ran on Georgian and English scans.
 */
function chapterSourceLang(titleId: string, chapterId: string): string {
  const chapter = lib.getChapter(titleId, chapterId);
  return chapter?.language || config.translate.defaultSource;
}

apiRouter.get('/translate/languages', (_req, res) => {
  res.json({
    targets: config.translate.targets,
    defaultSource: config.translate.defaultSource,
    llm: isLlmConfigured(),
  });
});

// Poll a chapter-translation job. Register before the :pageNumber route so
// 'status' isn't parsed as a page number.
apiRouter.get('/translate/:titleId/:chapterId/status', (req, res) => {
  const { titleId, chapterId } = req.params;
  const target = typeof req.query.target === 'string' ? req.query.target.toUpperCase() : 'EN';
  const job = getChapterTranslateStatus(titleId, chapterId, target);
  if (!job) {
    return res.json({ running: false, total: 0, done: 0, failed: 0, pages: [], known: false });
  }
  res.json({ ...job, known: true });
});

// Start translating every downloaded page of a chapter into `target`.
apiRouter.post('/translate/:titleId/:chapterId', (req, res) => {
  const { titleId, chapterId } = req.params;
  const target = typeof req.query.target === 'string' ? req.query.target.toUpperCase() : 'EN';
  if (!config.translate.targets.includes(target)) {
    return res.status(400).json({ error: `unsupported target: ${target}` });
  }
  const job = startChapterTranslate(titleId, chapterId, target);
  res.json({ started: job.running, ...job });
});

/** Shared guard for the per-page translation routes. */
function resolvePage(
  req: { params: Record<string, string>; query: Record<string, unknown> },
): { titleId: string; chapterId: string; pageNumber: number; target: string; localPath: string } | { error: string; status: number } {
  const { titleId, chapterId } = req.params;
  const pageNumber = Number(req.params.pageNumber);
  const target = typeof req.query.target === 'string' ? req.query.target.toUpperCase() : 'EN';
  if (!config.translate.targets.includes(target)) {
    return { error: `unsupported target: ${target}`, status: 400 };
  }
  const localPath = imgtranslator.pageLocalPath(titleId, chapterId, pageNumber);
  if (!localPath || !fs.existsSync(localPath)) {
    return { error: 'page not downloaded', status: 404 };
  }
  return { titleId, chapterId, pageNumber, target, localPath };
}

// The page with the original lettering erased but nothing drawn on top. The
// reader pairs it with the HTML text layer: an HTML box cannot follow the curve
// of a speech balloon, but an already-erased balloon does not need one.
apiRouter.get('/translate/:titleId/:chapterId/:pageNumber/clean', async (req, res) => {
  const resolved = resolvePage(req as never);
  if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });
  try {
    const result = await imgtranslator.renderPage(
      {
        titleId: resolved.titleId,
        chapterId: resolved.chapterId,
        pageNumber: resolved.pageNumber,
        sourceLang: chapterSourceLang(resolved.titleId, resolved.chapterId),
        targetLang: resolved.target,
        localPath: resolved.localPath,
      },
      'clean',
    );
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[clean p${resolved.pageNumber}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

// Text-layer description for a page: the reader draws it over the original
// scan, which keeps the artwork pristine and the text selectable.
apiRouter.get('/translate/:titleId/:chapterId/:pageNumber/overlay', async (req, res) => {
  const { titleId, chapterId } = req.params;
  const pageNumber = Number(req.params.pageNumber);
  const target = typeof req.query.target === 'string' ? req.query.target.toUpperCase() : 'EN';
  if (!config.translate.targets.includes(target)) {
    return res.status(400).json({ error: `unsupported target: ${target}` });
  }
  const localPath = imgtranslator.pageLocalPath(titleId, chapterId, pageNumber);
  if (!localPath || !fs.existsSync(localPath)) {
    return res.status(404).json({ error: 'page not downloaded' });
  }
  try {
    const overlay = await imgtranslator.pageOverlay({
      titleId,
      chapterId,
      pageNumber,
      sourceLang: chapterSourceLang(titleId, chapterId),
      targetLang: target,
      localPath,
    });
    res.setHeader('Cache-Control', 'no-cache');
    res.json(overlay);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[overlay p${pageNumber}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

apiRouter.get('/translate/:titleId/:chapterId/:pageNumber', async (req, res) => {
  const { titleId, chapterId } = req.params;
  const pageNumber = Number(req.params.pageNumber);
  const target = typeof req.query.target === 'string' ? req.query.target.toUpperCase() : 'EN';
  if (!config.translate.targets.includes(target)) {
    return res.status(400).json({ error: `unsupported target: ${target}` });
  }
  const localPath = imgtranslator.pageLocalPath(titleId, chapterId, pageNumber);
  if (!localPath || !fs.existsSync(localPath)) {
    return res.status(404).json({ error: 'page not downloaded' });
  }
  const sourceLang = chapterSourceLang(titleId, chapterId);
  try {
    const result = await imgtranslator.translatePage({
      titleId,
      chapterId,
      pageNumber,
      sourceLang,
      targetLang: target,
      localPath,
    });
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[translate p${pageNumber}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

apiRouter.get('/progress/:titleId', (req, res) => {
  const { titleId } = req.params;
  const p = lib.getProgress(titleId);
  res.json(p ?? { title_id: titleId, chapter_id: null, page: 0, mode: 'scroll' });
});

apiRouter.post('/progress', (req, res) => {
  const { titleId, chapterId, page = 0, mode = 'scroll' } = req.body ?? {};
  if (!titleId || !chapterId) return res.status(400).json({ error: 'titleId and chapterId required' });
  if (!lib.getChapter(titleId, chapterId)) return res.status(404).json({ error: 'chapter not found' });
  lib.setProgress(titleId, chapterId, Number(page ?? 0), mode === 'page' ? 'page' : 'scroll');
  res.json({ ok: true });
});

// Cover dir exposure for the CLI only.
export { coverDir };
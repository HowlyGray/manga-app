import { Router, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { coverDir, config } from '../config';
import * as ingest from '../services/ingest';
import * as lib from '../services/library';
import * as imgtranslator from '../services/imgtranslate';
import { isLlmConfigured } from '../services/translator';
import { langSpec } from '../services/lang';
import { hasProvider, listProviders } from '../sources';
import { coverFile } from '../services/sourceCache';
import { previewChapterInfo, previewPages } from '../services/preview';
import {
  deleteCorrection,
  listCorrections,
  listWordCorrections,
  saveCorrection,
} from '../services/corrections';
import { decodeId, getProvider, isLibraryId } from '../sources';
import { downloadChapter } from '../downloader';
import {
  getChapterTranslateStatus,
  startChapterTranslate,
  translatingChapters,
} from '../services/chapterTranslate';
import {
  clearTranslations,
  libraryUsage,
  removeChapterFiles,
  removeTitle,
  titleUsage,
} from '../services/storage';
import { startUpdateCheck, updateCheckStatus } from '../services/updates';

export const apiRouter = Router();

// Ids become directory names further down, so a malformed one is refused here
// rather than trusted to later sanitizing.
for (const name of ['id', 'titleId', 'chapterId']) {
  apiRouter.param(name, (_req, res, next, value: string) => {
    if (isLibraryId(value)) return next();
    res.status(400).json({ error: `invalid ${name}` });
  });
}
apiRouter.param('pageNumber', (_req, res, next, value: string) => {
  if (/^[1-9]\d{0,4}$/.test(value)) return next();
  res.status(400).json({ error: 'invalid page number' });
});

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

/** Content sources the server can browse, and what each one supports. */
apiRouter.get('/sources', (_req, res) => {
  res.json({
    sources: listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      browsable: p.browsable,
      hasTags: typeof p.listTags === 'function',
      hasShelves: typeof p.homeShelves === 'function',
    })),
  });
});

/** Genres, themes and formats a source can filter by. */
apiRouter.get('/tags', async (req, res) => {
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  if (source && !hasProvider(source)) {
    return res.status(400).json({ error: `unknown source: ${source}` });
  }
  try {
    res.json({ source: source ?? 'mangadex', tags: await ingest.sourceTags(source) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tags] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

/** Featured rows for the home page. */
apiRouter.get('/home', async (req, res) => {
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  if (source && !hasProvider(source)) {
    return res.status(400).json({ error: `unknown source: ${source}` });
  }
  try {
    const { source: used, shelves } = await ingest.homeShelves(source);
    res.json({
      source: used,
      shelves: shelves.map((shelf) => ({
        id: shelf.id,
        title: shelf.title,
        subtitle: shelf.subtitle,
        browse: shelf.browse ?? null,
        titles: shelf.titles.map((t) => ({
          id: t.libraryId,
          source: used,
          title: t.title,
          altTitles: [],
          originalLanguage: t.originalLang,
          year: t.year,
          status: t.status,
          tags: t.tags.slice(0, 6),
          coverUrl: `/api/cover/${encodeURIComponent(t.libraryId)}`,
          isSaved: lib.getTitle(t.libraryId) != null,
        })),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[home] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

apiRouter.get('/discover', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const lang = typeof req.query.lang === 'string' && LANGS.includes(req.query.lang) ? req.query.lang : undefined;
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  if (source && !hasProvider(source)) {
    return res.status(400).json({ error: `unknown source: ${source}` });
  }
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 24) || 24));
  const tags = typeof req.query.tags === 'string' ? req.query.tags.split(',').filter(Boolean) : undefined;
  const sort = typeof req.query.sort === 'string' ? (req.query.sort as never) : undefined;
  const createdSince = typeof req.query.createdSince === 'string' ? req.query.createdSince : undefined;
  let result: Awaited<ReturnType<typeof ingest.discover>>;
  try {
    result = await ingest.discover({
      q,
      lang,
      limit,
      offset: (page - 1) * limit,
      source,
      tags,
      sort,
      createdSince,
    });
  } catch (err) {
    // Without this the default Express handler answers an HTML error page to a
    // JSON endpoint, and the client reports a parse error instead of the cause.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[discover] FAILED: ${message}`);
    return res.status(502).json({ error: message });
  }
  // Pages the client may actually ask for: bounded by the match count when the
  // source reports one, and by the offset the source will accept. A pager built
  // from MangaDex's raw total would offer 2400 pages, of which 334 work.
  // The last usable page is the one whose offset still lands within the source's
  // limit, so it is floor(maxOffset / limit) + 1 -- not ceil over the item count.
  const byOffset = result.maxOffset == null ? Infinity : Math.floor(result.maxOffset / limit) + 1;
  const byTotal = result.total == null ? Infinity : Math.ceil(result.total / limit);
  const bound = Math.min(byOffset, byTotal);
  const pages = Number.isFinite(bound) ? Math.max(1, bound) : 0;

  res.json({
    total: result.total,
    page,
    limit,
    // 0 means "unknown": the client falls back to a next/previous pager.
    pages,
    hasMore: pages > 0 ? page < pages : result.titles.length >= limit,
    source: result.source,
    titles: result.titles.map((t) => ({
      id: t.libraryId,
      source: result.source,
      title: t.title,
      altTitles: t.altTitles.slice(0, 5),
      originalLanguage: t.originalLang,
      year: t.year,
      status: t.status,
      tags: t.tags.slice(0, 6),
      // Point at our own cache rather than the upstream CDN.
      coverUrl: `/api/cover/${encodeURIComponent(t.libraryId)}`,
      isSaved: lib.getTitle(t.libraryId) != null,
    })),
  });
});

apiRouter.get('/library', (_req, res) => {
  res.json(lib.listLibrary());
});

// Library-wide check for new chapters. Registered before `/library/:id`, which
// would otherwise take `check-updates` for a title id. The web app sends
// `?stale=1` when it opens, which leaves out titles checked recently; the
// button on the library page checks every title.
apiRouter.post('/library/check-updates', (req, res) => {
  const stale = req.query.stale === '1' || req.query.stale === 'true';
  res.json(startUpdateCheck(stale ? { olderThanMs: config.updates.staleMs } : {}));
});

apiRouter.get('/library/check-updates', (_req, res) => {
  res.json(
    updateCheckStatus() ?? {
      running: false,
      total: 0,
      checked: 0,
      found: 0,
      failed: [],
      startedAt: null,
      finishedAt: null,
    },
  );
});

/** The title has been looked at: its chapters stop counting as new. */
apiRouter.post('/library/:id/seen', (req, res) => {
  lib.markSeen(req.params.id);
  res.json({ ok: true });
});

/**
 * Looks for new chapters and changed details of one saved title. Opening a
 * title page asks for this, and is answered from the last check when that was
 * recent; `?full=1` -- the Refresh button -- lists every chapter again.
 */
apiRouter.post('/library/:id/refresh', async (req, res) => {
  const { id } = req.params;
  if (!lib.getTitle(id)) return res.status(404).json({ error: 'not in the library' });
  const full = req.query.full === '1' || req.query.full === 'true';

  const checkedAt = lib.getChecked(id);
  if (!full && checkedAt && Date.now() - checkedAt.getTime() < config.updates.titleFreshMs) {
    return res.json({
      refreshed: false,
      added: 0,
      upgrades: 0,
      fresh: [],
      news: 0,
      detailsChanged: false,
      incremental: true,
      checkedAt: checkedAt.toISOString(),
    });
  }
  try {
    const result = await ingest.refreshTitle(id, { full });
    res.json({ refreshed: true, ...result, checkedAt: lib.getChecked(id)?.toISOString() ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[refresh ${id}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

/** Disk use of every saved title. Registered before `/library/:id` for the same reason. */
apiRouter.get('/library/usage', async (_req, res) => {
  res.json(await libraryUsage());
});

apiRouter.get('/library/:id/usage', async (req, res) => {
  res.json(await titleUsage(req.params.id));
});

/**
 * Why files of a title (or of one of its chapters) cannot be deleted right
 * now, or null when nothing is using them.
 */
function busyWith(titleId: string, chapterId?: string): string | null {
  if (runningTitleDownloads.has(titleId)) return 'the title is downloading';
  const ids = chapterId ? [chapterId] : lib.listChapters(titleId).map((c) => c.id);
  if (ids.some((c) => runningChapterDownloads.has(c))) return 'a chapter is downloading';
  const translating = translatingChapters(titleId);
  if (ids.some((c) => translating.has(c))) return 'a chapter is being translated';
  return null;
}

/** Removes a title from the library, with its pages and caches. */
apiRouter.delete('/library/:id', async (req, res) => {
  const { id } = req.params;
  if (!lib.getTitle(id)) return res.status(404).json({ error: 'not in the library' });
  const busy = busyWith(id);
  if (busy) return res.status(409).json({ error: `${busy}; try again once it has finished` });
  res.json({ freed: await removeTitle(id) });
});

/** Deletes a chapter's downloaded pages; the chapter stays in the list. */
apiRouter.delete('/library/:id/chapters/:chapterId/files', async (req, res) => {
  const { id, chapterId } = req.params;
  if (!lib.getChapter(id, chapterId)) return res.status(404).json({ error: 'chapter not in the library' });
  const busy = busyWith(id, chapterId);
  if (busy) return res.status(409).json({ error: `${busy}; try again once it has finished` });
  res.json({ freed: await removeChapterFiles(id, chapterId) });
});

/** Deletes a title's translated renders; they are rebuilt when next read. */
apiRouter.delete('/library/:id/translations', async (req, res) => {
  const { id } = req.params;
  if (!lib.getTitle(id)) return res.status(404).json({ error: 'not in the library' });
  if (translatingChapters(id).size > 0) {
    return res.status(409).json({ error: 'a chapter is being translated; try again once it has finished' });
  }
  res.json({ freed: await clearTranslations(id) });
});

apiRouter.get('/library/:id', async (req, res) => {
  const { id } = req.params;
  const title = lib.getTitle(id);

  // Title not in library yet: browse it from MangaDex without importing.
  if (!title) {
    try {
      // `?refresh=1` skips the cache for this one read.
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const remote = await ingest.remoteTitleDetail(id, { refresh });
      // Reading is remembered per chapter, so previewed titles have it too.
      const reads = lib.readsFor(id);
      return res.json({
        inLibrary: false,
        coverUrl: `/api/cover/${encodeURIComponent(id)}`,
        title: {
          id: remote.id,
          provider: remote.source,
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
            read: reads.get(c.id) ?? null,
          })),
        },
        progress: lib.getProgress(id),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(404).json({ error: message });
    }
  }

  const reads = lib.readsFor(id);
  // Worked out before the title page marks the title seen, so it can still
  // point out what is new.
  const fresh = lib.newChapterIds(id);
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
    read: reads.get(c.id) ?? null,
    isNew: fresh.has(c.id),
  }));
  const progress = lib.getProgress(id);
  res.json({
    inLibrary: true,
    checkedAt: lib.getChecked(id)?.toISOString() ?? null,
    coverUrl: `/api/cover/${encodeURIComponent(id)}`,
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
  // `mangadexId` predates multiple sources; `id` is the current spelling and
  // carries a `provider:` prefix for anything that is not MangaDex.
  const raw = req.body ?? {};
  const mangadexId: unknown = raw.id ?? raw.mangadexId;
  if (!isLibraryId(mangadexId)) {
    return res.status(400).json({ error: 'a valid id is required' });
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
  try {
    // Imports the title when needed and adds this exact chapter, which an
    // import on its own may have filtered out in favour of another language.
    await ingest.ensureChapter(id, chapterId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import ${id}] FAILED: ${message}`);
    return res.status(502).json({ error: message });
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

/**
 * Covers for any title the app has seen, saved or not. The first request
 * downloads and stores the image; later ones are served from disk, so browsing
 * the same page twice costs the upstream CDN nothing.
 */
async function sendCover(id: string, res: Response): Promise<void> {
  const file = await coverFile(id);
  if (!file || !fs.existsSync(file)) {
    res.status(404).json({ error: 'no cover' });
    return;
  }
  res.setHeader('Content-Type', contentType(file));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.resolve(file));
}

apiRouter.get('/cover/:id', async (req, res) => {
  await sendCover(req.params.id, res);
});

// Kept because saved titles have linked to it since before the cover cache.
apiRouter.get('/library/:id/cover', async (req, res) => {
  await sendCover(req.params.id, res);
});

apiRouter.get('/library/data/:titleId/:chapterId/:pageNumber', (req, res) => {
  const { titleId, chapterId } = req.params;
  const pageNumber = Number(req.params.pageNumber);
  // Resolves through the file on disk, so a chapter whose rows lost their
  // paths still serves instead of 404-ing with every image sitting right there.
  const local = lib.pageFile(titleId, chapterId, pageNumber);
  if (!local) {
    return res.status(404).json({ error: 'page not downloaded' });
  }
  const filePath = path.resolve(local);
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

/**
 * A chapter read straight from its source, with nothing saved. Mirrors the
 * shape of the downloaded-chapter response so the reader renders both the same
 * way; `preview: true` is what tells it the pages are not local.
 */
apiRouter.get('/preview/:titleId/:chapterId', async (req, res) => {
  const { titleId, chapterId } = req.params;
  try {
    const [info, pages] = await Promise.all([
      previewChapterInfo(titleId, chapterId),
      previewPages(titleId, chapterId),
    ]);
    const encoded = `${encodeURIComponent(titleId)}/${encodeURIComponent(chapterId)}`;
    res.json({
      preview: true,
      chapter: {
        id: chapterId,
        chapter: info?.chapter ?? null,
        title: info?.title ?? null,
        volume: info?.volume ?? null,
        language: info?.language ?? '',
        languageLabel: langSpec(info?.language).label,
        pages: pages.length,
        scanlator: info?.scanlator ?? null,
        publishedAt: info?.publishedAt ?? null,
        downloaded: 0,
        downloadError: null,
        downloading: false,
      },
      pages: pages.map((_, i) => ({
        pageNumber: i + 1,
        downloaded: 0,
        url: `/api/preview/${encoded}/${i + 1}`,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[preview ${chapterId}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

/** Streams one preview page through the provider, so its headers apply. */
apiRouter.get('/preview/:titleId/:chapterId/:pageNumber', async (req, res) => {
  const { titleId, chapterId } = req.params;
  const pageNumber = Number(req.params.pageNumber);
  try {
    const pages = await previewPages(titleId, chapterId);
    const image = pages[pageNumber - 1];
    if (!image) return res.status(404).json({ error: 'page out of range' });

    const upstream = await getProvider(decodeId(titleId).provider).fetchImage(image);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `source returned HTTP ${upstream.status}` });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
    // Only the browser caches these; nothing is written to the library.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[preview ${chapterId} p${pageNumber}] FAILED: ${message}`);
    res.status(502).json({ error: message });
  }
});

/**
 * Readings the user has corrected, reused on every later page: whole bubbles,
 * and the misread words learned from them.
 */
apiRouter.get('/corrections', (req, res) => {
  const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
  res.json({ corrections: listCorrections(lang), words: listWordCorrections(lang) });
});

/**
 * Stores a correction. `source` is the raw OCR reading (the overlay block's
 * `reading`), not text a previous correction already produced.
 */
apiRouter.post('/corrections', (req, res) => {
  const { sourceLang, source, corrected } = req.body ?? {};
  if (
    typeof sourceLang !== 'string' ||
    !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(sourceLang) ||
    typeof source !== 'string' ||
    typeof corrected !== 'string'
  ) {
    return res.status(400).json({ error: 'sourceLang, source and corrected are required' });
  }
  if (!corrected.trim()) {
    deleteCorrection(sourceLang, source);
    return res.json({ ok: true, removed: true });
  }
  saveCorrection(sourceLang, source, corrected);
  res.json({ ok: true });
});

apiRouter.get('/translate/languages', (_req, res) => {
  res.json({
    targets: config.translate.targets,
    defaultSource: config.translate.defaultSource,
    llm: isLlmConfigured(),
    chapterLanguages: config.translate.chapterLanguages,
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
    // Not `immutable`: the same URL serves a new render after a pipeline
    // upgrade. The browser revalidates with the ETag and gets a 304 until then.
    res.setHeader('Cache-Control', 'no-cache');
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
    const overlay = await imgtranslator.pageOverlay(
      {
        titleId,
        chapterId,
        pageNumber,
        sourceLang: chapterSourceLang(titleId, chapterId),
        targetLang: target,
        localPath,
      },
      { refresh: req.query.refresh === '1' },
    );
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
    // A correction redraws this image under the same URL, which `immutable`
    // kept the browser from ever seeing. Revalidation is a cheap 304 otherwise.
    res.setHeader('Cache-Control', 'no-cache');
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

/**
 * Records the page being read. Chapters read in preview count too: reads are
 * kept per chapter, not tied to the library. `pages` lets the server mark the
 * chapter finished when the last one is reached.
 */
apiRouter.post('/progress', (req, res) => {
  const { titleId, chapterId, page = 0, mode = 'scroll', pages } = req.body ?? {};
  if (!isLibraryId(titleId) || !isLibraryId(chapterId)) {
    return res.status(400).json({ error: 'titleId and chapterId required' });
  }
  const at = Math.max(0, Math.floor(Number(page) || 0));
  const count = Number.isInteger(pages) && pages > 0 ? (pages as number) : null;
  lib.setProgress(titleId, chapterId, at, mode === 'page' ? 'page' : 'scroll', count);
  res.json({ ok: true });
});

/** Marks a chapter read or unread by hand, from the chapter list. */
apiRouter.post('/library/:id/chapters/:chapterId/read', (req, res) => {
  const { id, chapterId } = req.params;
  const finished = req.body?.finished;
  if (typeof finished !== 'boolean') return res.status(400).json({ error: 'finished must be true or false' });
  lib.setChapterFinished(id, chapterId, finished);
  res.json({ ok: true });
});

// Cover dir exposure for the CLI only.
export { coverDir };
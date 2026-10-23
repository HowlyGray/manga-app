import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { formatBytes, timeAgo } from '../format';
import { chapterKey, summarizeReading } from '../reading';
import type { ChapterView, DownloadStatus, TitleDetailResponse, Usage } from '../types';
import Pagination from '../components/Pagination';

const TARGET_LANGS = ['EN', 'FR', 'DE', 'ES', 'PT-BR', 'IT', 'NL', 'PL', 'RU', 'KO', 'JA', 'ZH-HANS', 'ZH-HANT', 'TR', 'ID'];
type TState = { target: string; running: boolean; done: number; total: number; failed: number; error?: string };

const CHAPTERS_PER_PAGE = 60;

export default function TitleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<TitleDetailResponse | null>(null);
  const [dl, setDl] = useState<DownloadStatus | null>(null);
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);
  const [activeLang, setActiveLang] = useState('');
  const [trl, setTrl] = useState<Record<string, TState>>({});
  const [chFilter, setChFilter] = useState('');
  const [chDesc, setChDesc] = useState(false);
  const [chPage, setChPage] = useState(1);
  /** Bytes this title takes on disk; saved titles only. */
  const [usage, setUsage] = useState<Usage | null>(null);
  /** The source is being asked whether this title has anything new. */
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  /** What the last manual check found, shown until the next one. */
  const [checkNote, setCheckNote] = useState('');

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const t = await api.title(id!);
      setData(t);
      setCheckedAt(t.checkedAt ?? null);
      if (t.inLibrary) {
        setDl(await api.downloadStatus(id!));
        api.titleUsage(id!).then(setUsage, () => {});
      } else {
        setDl(null);
        setUsage(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  async function removeFromLibrary() {
    if (!id || !data) return;
    const total = usage ? usage.pages + usage.translations + usage.ocr : null;
    const deletes =
      total === 0
        ? 'This deletes what was recorded about reading it.'
        : `This deletes ${total == null ? 'its' : formatBytes(total) + ' of'} downloaded pages and translations, and what was recorded about reading it.`;
    const ok = window.confirm(`Remove "${data.title.title}" from the library?\n\n${deletes}`);
    if (!ok) return;
    try {
      await api.removeTitle(id);
      navigate('/library');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function clearTranslations() {
    if (!id || !usage) return;
    const ok = window.confirm(
      `Delete ${formatBytes(usage.translations)} of translated pages?\n\nThey are rebuilt the next time you read this title translated.`,
    );
    if (!ok) return;
    try {
      await api.clearTranslations(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteChapterFiles(c: ChapterView) {
    if (!id) return;
    const name = c.chapter ? `chapter ${c.chapter}` : 'this chapter';
    if (!window.confirm(`Delete the downloaded pages of ${name}? You can download it again later.`)) return;
    try {
      await api.deleteChapterFiles(id, c.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Chapters that were new when the page opened; kept while it stays open. */
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const seenFor = useRef<string | null>(null);

  // Opening a saved title marks its chapters seen. The server reports what was
  // new before that, and it is remembered here so later reloads -- the page
  // polls during downloads -- do not wipe the markers.
  useEffect(() => {
    if (!id || !data?.inLibrary || seenFor.current === id) return;
    seenFor.current = id;
    setNewIds(new Set(data.chapters.items.filter((c) => c.isNew).map((c) => c.id)));
    api.markSeen(id).catch(() => {});
  }, [id, data]);

  const openId = useRef(id);
  openId.current = id;

  /**
   * Asks the source whether this title has anything new. Opening the page does
   * it quietly; the Refresh button lists every chapter again and says what it
   * found. Whatever turns up is added to the list, marked NEW, and counts as
   * seen since it is on screen.
   */
  const lookForNew = useCallback(
    async (full: boolean) => {
      if (!id) return;
      setChecking(true);
      setCheckNote('');
      try {
        const result = await api.refreshTitle(id, full);
        // The reader may have moved on to another title while this was running.
        if (openId.current !== id) return;
        setCheckedAt(result.checkedAt);
        if (result.fresh.length > 0) {
          setNewIds((known) => new Set([...known, ...result.fresh]));
          api.markSeen(id).catch(() => {});
        }
        if (result.added > 0 || result.detailsChanged) await refresh();
        if (full) {
          const found = result.news > 0 ? `Found ${result.news} new chapter${result.news === 1 ? '' : 's'}.` : '';
          // They sit next to the copy that was there, so the list grows without a new chapter.
          const better =
            result.upgrades > 0
              ? `Added ${result.upgrades} better translation${result.upgrades === 1 ? '' : 's'} of chapters you already have; the language filters show them.`
              : '';
          setCheckNote([found, better].filter(Boolean).join(' ') || 'Already up to date.');
        }
      } catch (e) {
        if (openId.current === id) setCheckNote(`Could not check for new chapters: ${(e as Error).message}`);
      } finally {
        if (openId.current === id) setChecking(false);
      }
    },
    [id, refresh],
  );

  const checkedFor = useRef<string | null>(null);

  // Opening a saved title asks its source whether anything is new, so the
  // chapter list is current without pressing anything.
  useEffect(() => {
    if (!id || !data?.inLibrary || checkedFor.current === id) return;
    checkedFor.current = id;
    void lookForNew(false);
  }, [id, data, lookForNew]);

  useEffect(() => {
    if (!polling || !id) return;
    const t = setInterval(async () => {
      const d = await api.downloadStatus(id!).catch(() => null);
      if (!d) return;
      setDl(d);
      await refresh();
      if (!d.running) setPolling(false);
    }, 1500);
    return () => clearInterval(t);
  }, [polling, id, refresh]);

  async function downloadAll() {
    if (!id) return;
    setError('');
    const res = await api.startDownload(id);
    if (res.started) setPolling(true);
  }

  async function addToLibrary() {
    if (!id) return;
    setError('');
    await api.importTitle(id!);
    await refresh();
  }

  async function downloadOne(chapterId: string) {
    if (!id) return;
    setError('');
    await api.downloadChapter(id, chapterId);
    setPolling(true);
    await refresh();
  }

  async function translateChapter(chapterId: string, target: string) {
    if (!id || !target) return;
    if (trl[chapterId]?.running) return;
    setError('');
    setTrl((m) => ({ ...m, [chapterId]: { target, running: true, done: 0, total: 0, failed: 0 } }));
    try {
      const job = await api.startChapterTranslate(id, chapterId, target);
      setTrl((m) => ({ ...m, [chapterId]: { target, running: job.running, done: job.done, total: job.total, failed: job.failed, error: job.error } }));
    } catch (e) {
      setTrl((m) => ({ ...m, [chapterId]: { target, running: false, done: 0, total: 0, failed: 0, error: (e as Error).message } }));
    }
  }

  /** Marks a chapter read or unread, updating the row before the server answers. */
  async function toggleRead(c: ChapterView) {
    if (!id) return;
    const finished = !c.read?.finished;
    setData((d) =>
      d && {
        ...d,
        chapters: {
          ...d.chapters,
          items: d.chapters.items.map((x) =>
            x.id === c.id ? { ...x, read: { page: finished ? (x.read?.page ?? 0) : 0, pages: x.read?.pages ?? null, finished } } : x,
          ),
        },
      },
    );
    try {
      await api.markChapterRead(id, c.id, finished);
    } catch (e) {
      setError((e as Error).message);
    }
    // "Continue reading" may have moved on.
    await refresh();
  }

  // Poll any in-flight chapter translations so progress and completion update live.
  useEffect(() => {
    if (!id) return;
    const running = Object.values(trl).filter((s) => s.running);
    if (running.length === 0) return;
    const t = setInterval(async () => {
      const updates: Record<string, TState> = {};
      for (const [chapterId, s] of Object.entries(trl)) {
        if (!s.running) continue;
        try {
          const job = await api.chapterTranslateStatus(id!, chapterId, s.target);
          updates[chapterId] = { target: s.target, running: job.running, done: job.done, total: job.total, failed: job.failed, error: job.error };
        } catch {
          /* keep last state */
        }
      }
      if (Object.keys(updates).length > 0) setTrl((m) => ({ ...m, ...updates }));
    }, 2000);
    return () => clearInterval(t);
  }, [id, trl]);

  if (!data) {
    return error ? <div className="error">{error}</div> : <div className="loading"><span className="spinner" />Loading…</div>;
  }

  const { title, chapters, progress, languages } = data;
  const pct = dl && dl.total > 0 ? Math.round((dl.downloaded / dl.total) * 100) : 0;

  const reading = summarizeReading(chapters.items, progress?.chapter_id);
  const continueWith = reading.next;
  // In reading order, so the first is where the new chapters start. They sit at
  // the far end of a long list, which is why they get a banner of their own.
  const fresh = chapters.items.filter((c) => newIds.has(c.id));
  const firstNew = fresh[0];
  const freshCount = new Set(fresh.map(chapterKey)).size;
  const ago = timeAgo(checkedAt);
  const checkLine = checking
    ? 'Checking for new chapters…'
    : checkNote || (ago ? `Checked for new chapters ${ago}.` : '');
  const byLang = activeLang
    ? chapters.items.filter((c) => c.language === activeLang)
    : chapters.items;
  const needle = chFilter.trim().toLowerCase();
  const matching = needle
    ? byLang.filter((c) =>
        `${c.chapter ?? ''} ${c.title ?? ''} ${c.scanlator ?? ''}`.toLowerCase().includes(needle),
      )
    : byLang;
  const ordered: ChapterView[] = chDesc ? [...matching].reverse() : matching;
  // Long-running series reach several hundred chapters; rendering them all at
  // once makes the page crawl and buries the chapter you came for.
  const chPages = Math.max(1, Math.ceil(ordered.length / CHAPTERS_PER_PAGE));
  const chapterPage = Math.min(chPage, chPages);
  const visible = ordered.slice(
    (chapterPage - 1) * CHAPTERS_PER_PAGE,
    chapterPage * CHAPTERS_PER_PAGE,
  );
  const coverSrc = data.coverUrl ?? `/api/library/${title.id}/cover`;

  return (
    <div>
      <div className="detail-header">
        <img
          className="detail-cover"
          src={coverSrc}
          alt={title.title}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
          }}
        />
        <div className="detail-info">
          <h1>{title.title}</h1>
          <div className="meta-row">
            {title.author && <span>✍️ {title.author}</span>}
            {title.status && <span className="tag">{title.status}</span>}
            {title.year && <span>{title.year}</span>}
            {(title.original_lang ?? '').toUpperCase() && (
              <span className="tag">{(title.original_lang ?? '').toUpperCase()}</span>
            )}
            {title.jikan_score != null && <span>★ {title.jikan_score.toFixed(2)}</span>}
          </div>
          {title.tags.length > 0 && (
            <div className="meta-row">
              {title.tags.map((t) => (
                <span key={t} className="tag">{t}</span>
              ))}
            </div>
          )}
          {title.synopsis && <p className="synopsis">{title.synopsis}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={downloadAll} disabled={polling}>
              {polling
                ? 'Download in progress…'
                : data.inLibrary
                  ? '⬇ Download all chapters'
                  : '⬇ Add & download all'}
            </button>
            {data.inLibrary ? (
              <button
                className="btn"
                onClick={() => lookForNew(true)}
                disabled={checking}
                title="List every chapter of this title again, including better translations of chapters you have, and refresh its details"
              >
                {checking ? '⟳ Checking…' : '⟳ Refresh'}
              </button>
            ) : (
              <button className="btn" onClick={addToLibrary}>
                ＋ Add to library
              </button>
            )}
          </div>
          {data.inLibrary && checkLine && (
            <p className="hint" role="status" style={{ marginTop: 8, marginBottom: 0 }}>
              {checkLine}
            </p>
          )}
          {data.inLibrary && (
            <div className="storage-row">
              {usage && (
                <span className="muted small">
                  On disk: {formatBytes(usage.pages)} of pages
                  {usage.translations > 0 ? ` · ${formatBytes(usage.translations)} of translations` : ''}
                </span>
              )}
              {usage && usage.translations > 0 && (
                <button className="btn small ghost" onClick={clearTranslations}>
                  Clear translations
                </button>
              )}
              <button className="btn small ghost danger" onClick={removeFromLibrary}>
                Remove from library
              </button>
            </div>
          )}
          {!data.inLibrary && (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Not in your library yet — downloading a chapter will add it automatically.
            </p>
          )}
          {continueWith && (
            <Link to={`/library/${title.id}/read/${continueWith.id}`}>
              <button className="btn" style={{ marginTop: 10 }}>
                {reading.resuming ? 'Continue' : 'Next'}:{' '}
                {continueWith.chapter ? `Ch. ${continueWith.chapter}` : 'One-shot'}
                {reading.resuming && continueWith.read?.page ? ` · p. ${continueWith.read.page}` : ''}
              </button>
            </Link>
          )}
          {reading.caughtUp && <p className="hint" style={{ marginTop: 10 }}>✓ All caught up</p>}
          {reading.read > 0 && (
            <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
              {reading.read} of {reading.total} chapters read
            </p>
          )}
        </div>
      </div>

      {firstNew && (
        <div className="notice new-banner">
          <span>
            <strong>
              {freshCount} new chapter{freshCount === 1 ? '' : 's'}
            </strong>{' '}
            since you last looked
          </span>
          <Link to={`/library/${title.id}/read/${firstNew.id}`}>
            <button className="btn small primary">
              Read {firstNew.chapter ? `Ch. ${firstNew.chapter}` : 'it'}
            </button>
          </Link>
        </div>
      )}

      {dl && dl.total > 0 && (
        <div className="dl-bar">
          <span>
            {dl.running ? 'Downloading…' : 'Download status'} · {dl.downloaded}/{dl.total}
          </span>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          {dl.failed > 0 && <span style={{ color: 'var(--danger)' }}>{dl.failed} failed</span>}
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

      {languages.length > 1 && (
        <div className="chips" style={{ marginBottom: 14 }}>
          <button
            className={`chip ${activeLang === '' ? 'active' : ''}`}
            onClick={() => setActiveLang('')}
          >
            All ({chapters.items.length})
          </button>
          {languages.map((l) => {
            const n = chapters.items.filter((c) => c.language === l).length;
            return (
              <button
                key={l}
                className={`chip ${activeLang === l ? 'active' : ''}`}
                onClick={() => setActiveLang(activeLang === l ? '' : l)}
              >
                {l.toUpperCase()} ({n})
              </button>
            );
          })}
        </div>
      )}

      <div className="chapter-toolbar">
        <input
          className="search"
          placeholder="Filter chapters…"
          value={chFilter}
          onChange={(e) => {
            setChFilter(e.target.value);
            setChPage(1);
          }}
        />
        <button className="btn small" onClick={() => setChDesc((v) => !v)}>
          {chDesc ? '↓ Newest first' : '↑ Oldest first'}
        </button>
        <span className="muted small">
          {ordered.length} chapter{ordered.length === 1 ? '' : 's'}
          {chPages > 1 ? ` · page ${chapterPage} of ${chPages}` : ''}
        </span>
      </div>

      {visible.length === 0 && (
        <div className="empty">
          {needle ? 'No chapter matches that filter.' : 'No chapters in this language.'}
        </div>
      )}

      <div className="chapter-list">
        {visible.map((c) => {
          const st = trl[c.id];
          return (
          <div key={c.id} className={`chapter-row${c.read?.finished ? ' is-read' : ''}`}>
            <span className="chapter-num">{c.chapter ?? '•'}</span>
            <div className="chapter-title">
              {newIds.has(c.id) && <span className="new-tag">NEW</span>}
              {c.title ?? (c.chapter ? `Chapter ${c.chapter}` : 'One-shot')}
              <div className="chapter-sub">
                {c.pages ? `${c.pages} pages` : ''}
                {c.scanlator ? ` · ${c.scanlator}` : ''}
                {c.language ? ` · ${c.language}` : ''}
                {c.read && !c.read.finished && c.read.page > 0
                  ? ` · read to p. ${c.read.page}${c.read.pages ? `/${c.read.pages}` : ''}`
                  : ''}
              </div>
            </div>
            <div className="chapter-actions">
              <button
                className="btn small ghost"
                onClick={() => toggleRead(c)}
                title={c.read?.finished ? 'Mark as unread' : 'Mark as read'}
                aria-pressed={Boolean(c.read?.finished)}
              >
                {c.read?.finished ? '✓ Read' : 'Mark read'}
              </button>
              {c.downloaded === 1 && <span className="badge-ok tag">✓ downloaded</span>}
              {c.downloaded === 1 && data.inLibrary && (
                <button
                  className="btn small ghost"
                  onClick={() => deleteChapterFiles(c)}
                  title="Delete the downloaded pages"
                  aria-label="Delete the downloaded pages"
                >
                  🗑
                </button>
              )}
              {c.downloaded === -1 && <span className="badge-failed tag">✗ failed</span>}
              {c.downloaded !== 1 && (
                <button className="btn small" onClick={() => downloadOne(c.id)}>
                  ⬇
                </button>
              )}
              {st && (
                <span className="tag">
                  {st.running
                    ? `Translating… ${st.done}/${st.total}`
                    : st.total > 0 && st.done === st.total && st.failed === 0
                      ? `✓ translated → ${st.target}`
                      : st.error
                        ? `✗ ${st.error}`
                        : st.done > 0
                          ? `${st.done}/${st.total} → ${st.target}`
                          : ''}
                </span>
              )}
              {c.downloaded === 1 && (
                <select
                  className="chip"
                  value=""
                  onChange={(e) => e.target.value && translateChapter(c.id, e.target.value)}
                  title="Translate this chapter"
                >
                  <option value="">Translate ▾</option>
                  {TARGET_LANGS.map((l) => (
                    <option key={l} value={l}>
                      → {l}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="btn small primary"
                onClick={() => navigate(`/library/${id}/read/${c.id}`)}
                title={c.downloaded === 1 ? 'Read the downloaded chapter' : 'Preview from the source'}
              >
                {c.downloaded === 1 ? 'Read' : 'Preview'}
              </button>
            </div>
          </div>
        );
        })}
      </div>

      <Pagination page={chapterPage} pages={chPages} hasMore={false} onChange={setChPage} />
    </div>
  );
}
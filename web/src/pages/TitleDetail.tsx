import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { DownloadStatus, TitleDetailResponse } from '../types';

const TARGET_LANGS = ['EN', 'FR', 'DE', 'ES', 'PT-BR', 'IT', 'NL', 'PL', 'RU', 'KO', 'JA', 'ZH-HANS', 'ZH-HANT', 'TR', 'ID'];
type TState = { target: string; running: boolean; done: number; total: number; failed: number; error?: string };

export default function TitleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<TitleDetailResponse | null>(null);
  const [dl, setDl] = useState<DownloadStatus | null>(null);
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);
  const [activeLang, setActiveLang] = useState('');
  const [trl, setTrl] = useState<Record<string, TState>>({});

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const t = await api.title(id!);
      setData(t);
      if (t.inLibrary) setDl(await api.downloadStatus(id!));
      else setDl(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  async function sync() {
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
  const visible = activeLang
    ? chapters.items.filter((c) => c.language === activeLang)
    : chapters.items;
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
              <button className="btn" onClick={sync}>
                ⟳ Sync metadata
              </button>
            ) : (
              <button className="btn" onClick={addToLibrary}>
                ＋ Add to library
              </button>
            )}
          </div>
          {!data.inLibrary && (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Not in your library yet — downloading a chapter will add it automatically.
            </p>
          )}
          {progress?.chapter_id && (
            <Link to={`/library/${title.id}/read/${progress.chapter_id}`}>
              <button className="btn" style={{ marginTop: 10 }}>
                Continue reading
              </button>
            </Link>
          )}
        </div>
      </div>

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

      {visible.length === 0 && (
        <div className="empty">No chapters in this language.</div>
      )}

      <div className="chapter-list">
        {visible.map((c) => {
          const st = trl[c.id];
          return (
          <div key={c.id} className="chapter-row">
            <span className="chapter-num">{c.chapter ?? '•'}</span>
            <div className="chapter-title">
              {c.title ?? (c.chapter ? `Chapter ${c.chapter}` : 'One-shot')}
              <div className="chapter-sub">
                {c.pages ? `${c.pages} pages` : ''}
                {c.scanlator ? ` · ${c.scanlator}` : ''}
                {c.language ? ` · ${c.language}` : ''}
              </div>
            </div>
            <div className="chapter-actions">
              {c.downloaded === 1 && <span className="badge-ok tag">✓ downloaded</span>}
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
                disabled={c.downloaded !== 1}
              >
                Read
              </button>
            </div>
          </div>
        );
        })}
      </div>
    </div>
  );
}
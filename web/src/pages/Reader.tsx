import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { ChapterDetailResponse, ChapterView, PageView, TitleDetailResponse } from '../types';

type Mode = 'page' | 'scroll';

function labelOf(c: ChapterView | null | undefined): string {
  if (!c) return '—';
  return c.chapter ? `Ch. ${c.chapter}${c.title ? ` · ${c.title}` : ''}` : 'One-shot';
}

const TARGET_LANGS = ['EN', 'FR', 'DE', 'ES', 'PT-BR', 'IT', 'NL', 'PL', 'RU', 'KO', 'JA', 'ZH-HANS', 'ZH-HANT', 'TR', 'ID'];

export default function Reader() {
  const { id, chapterId } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<ChapterDetailResponse | null>(null);
  const [titleInfo, setTitleInfo] = useState<TitleDetailResponse | null>(null);
  const [mode, setMode] = useState<Mode>('scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [translateLang, setTranslateLang] = useState('');
  const [translateHint, setTranslateHint] = useState('');

  const imgRefs = useRef<(HTMLImageElement | null)[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const downloadStarted = useRef(false);
  const restored = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError('');
    downloadStarted.current = false;
    restored.current = false;
    if (!id || !chapterId) return;

    (async () => {
      try {
        let ti = await api.title(id!);
        if (!ti.inLibrary) {
          await api.importTitle(id!);
          ti = await api.title(id!);
        }
        const ch = await api.chapter(id!, chapterId!);
        if (cancelled) return;
        setTitleInfo(ti);
        setDetail(ch);
        if (ti.progress?.chapter_id === chapterId) {
          setMode(ti.progress.mode === 'page' ? 'page' : 'scroll');
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, chapterId]);

  // Auto-download the chapter when opened and not yet local.
  useEffect(() => {
    if (!id || !chapterId || !detail) return;
    if (detail.chapter.downloaded === 1 || downloadStarted.current) return;

    downloadStarted.current = true;
    setDownloading(true);
    setError('');
    (async () => {
      try {
        await api.downloadChapter(id!, chapterId!);
        const poll = window.setInterval(async () => {
          const ch = await api.chapter(id!, chapterId!).catch(() => null);
          if (!ch) return;
          if (ch.chapter.downloaded === 1) {
            window.clearInterval(poll);
            setDetail(ch);
            setDownloading(false);
            window.scrollTo(0, 0);
          } else if (ch.chapter.downloaded === -1) {
            window.clearInterval(poll);
            setDetail(ch);
            setDownloading(false);
            setError(`Download failed: ${ch.chapter.downloadError ?? 'unknown'}`);
          }
        }, 2000);
      } catch (e) {
        setDownloading(false);
        setError((e as Error).message);
      }
    })();
  }, [id, chapterId, detail, retry]);

  const pages = detail?.pages ?? [];
  const downloaded = detail?.chapter.downloaded === 1;
  const ready = downloaded && pages.length > 0;

  function pageUrl(p: PageView): string {
    return translateLang ? `/api/translate/${id}/${chapterId}/${p.pageNumber}?target=${translateLang}` : p.url;
  }

  function onTranslate(lang: string) {
    setTranslateLang(lang);
    setTranslateHint(lang ? 'Translating pages…' : '');
    window.setTimeout(() => setTranslateHint(''), 5000);
  }

  // Restore scroll position for the same chapter (best effort while images load).
  useEffect(() => {
    if (!ready || mode !== 'scroll' || restored.current) return;
    restored.current = true;
    const saved = titleInfo?.progress;
    const target = saved && saved.chapter_id === chapterId ? saved.page - 1 : 0;
    if (target <= 0) return;
    let tries = 0;
    const tick = () => {
      const img = imgRefs.current[target];
      if (img) {
        img.scrollIntoView({ block: 'start' });
        return;
      }
      if (++tries < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [ready, mode, titleInfo, chapterId]);

  // Track current page when scrolling.
  useEffect(() => {
    if (mode !== 'scroll' || !ready) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const line = window.scrollY + window.innerHeight * 0.22;
        let cur = 0;
        for (let i = 0; i < imgRefs.current.length; i++) {
          const img = imgRefs.current[i];
          if (!img) continue;
          const top = img.getBoundingClientRect().top + window.scrollY;
          if (top <= line) cur = i;
          else break;
        }
        setPageIndex(cur);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [mode, ready]);

  function scheduleSave(page: number) {
    if (!id || !chapterId) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api.setProgress(id!, chapterId!, page + 1, mode).catch(() => {});
    }, 350);
  }

  useEffect(() => {
    if (detail && downloaded) scheduleSave(pageIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== 'page' || !ready) return;
      if (e.key === 'ArrowRight') setPageIndex((p) => Math.min(pages.length - 1, p + 1));
      if (e.key === 'ArrowLeft') setPageIndex((p) => Math.max(0, p - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, ready, pages.length]);

  const chapters = titleInfo?.chapters.items ?? [];
  const idx = chapters.findIndex((c) => c.id === chapterId);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  const current = chapters[idx];

  if (!detail) {
    return (
      <div className="reader">
        {error ? <div className="error">{error}</div> : <div className="loading"><span className="spinner" />Loading chapter…</div>}
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader-top">
        <Link to={`/library/${id}`} className="btn small">← Back</Link>
        <h2>{labelOf(current)}</h2>
        {detail.chapter.scanlator && (
          <span className="tag">📢 {detail.chapter.scanlator}</span>
        )}
        <div className="reader-mode">
          <button className={mode === 'page' ? 'active' : ''} onClick={() => setMode('page')}>
            Page
          </button>
          <button className={mode === 'scroll' ? 'active' : ''} onClick={() => setMode('scroll')}>
            Scroll
          </button>
          <select
            className="chip"
            value={translateLang}
            onChange={(e) => onTranslate(e.target.value)}
            title="Translate page text"
          >
            <option value="">Translate: Off</option>
            {TARGET_LANGS.map((l) => (
              <option key={l} value={l}>
                Translate → {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      {translateHint && <div className="notice">{translateHint}</div>}

      {downloading && (
        <div className="notice">
          <span className="spinner" />
          Downloading this chapter locally…
        </div>
      )}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!downloaded && !downloading && (
        <div className="notice">This chapter isn't downloaded yet.</div>
      )}

      {mode === 'scroll' && ready && (
        <div className="reader-pages scroll">
          {pages.map((p) => (
            <img
              key={p.pageNumber}
              ref={(el) => {
                imgRefs.current[p.pageNumber - 1] = el;
              }}
              src={pageUrl(p)}
              alt={`page ${p.pageNumber}`}
              loading="lazy"
            />
          ))}
        </div>
      )}

      {mode === 'page' && ready && pages.length > 0 && (
        <>
          <div className="reader-pages page">
            <div className="click-left" onClick={() => setPageIndex((p) => Math.max(0, p - 1))} />
            <img src={pageUrl(pages[pageIndex])} alt={`page ${pageIndex + 1}`} />
            <div
              className="click-right"
              onClick={() => setPageIndex((p) => Math.min(pages.length - 1, p + 1))}
            />
          </div>
          <div className="page-pos">
            {pageIndex + 1} / {pages.length}
          </div>
        </>
      )}

      {!downloaded && !downloading && !error && (
        <div>
          <button
            className="btn primary"
            onClick={() => {
              downloadStarted.current = false;
              setRetry((r) => r + 1);
            }}
          >
            Retry download
          </button>
        </div>
      )}

      <div className="reader-nav">
        <button
          className="btn"
          disabled={!prev}
          onClick={() => prev && navigate(`/library/${id}/read/${prev.id}`)}
        >
          ← {labelOf(prev)}
        </button>
        <button
          className="btn"
          disabled={!next}
          onClick={() => next && navigate(`/library/${id}/read/${next.id}`)}
        >
          {labelOf(next)} →
        </button>
      </div>
    </div>
  );
}
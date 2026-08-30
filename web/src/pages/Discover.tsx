import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { DiscoverItem, SourceInfo } from '../types';
import TitleCard from '../components/TitleCard';
import Pagination from '../components/Pagination';
import { useDebounce } from '../hooks';

const LANGS = [
  { key: '', label: 'All' },
  { key: 'ja', label: '🇯🇵 Manga' },
  { key: 'ko', label: '🇰🇷 Manhwa' },
];

const PER_PAGE = 30;

export default function Discover() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q, 400);
  const [lang, setLang] = useState('');

  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.sources().then(
      (r) => {
        setSources(r.sources);
        // Select the first source so the dropdown and the request agree.
        setSource((current) => current || r.sources[0]?.id || '');
      },
      () => setSources([]),
    );
  }, []);

  // Any filter change restarts at page one; changing the page keeps them.
  const filterKey = `${source}|${lang}|${debouncedQ}`;
  useEffect(() => {
    setPage(1);
    setPages(0);
  }, [filterKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .discover({ q: debouncedQ, lang, source, page, limit: PER_PAGE })
      .then((res) => {
        if (cancelled) return;
        setItems(res.titles);
        setTotal(res.total);
        // MangaDex reports a smaller `total` at deep offsets than at offset 0,
        // which would shrink the pager mid-browse and lose the user's place.
        // Filter changes reset it, so keeping the high-water mark is safe.
        setPages((prev) => Math.max(prev, res.pages));
        setHasMore(res.hasMore);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, lang, source, page]);

  // `/` jumps to the search box, as on most catalogue sites.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function goTo(next: number) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function add(id: string) {
    setBusy(id);
    setNote('');
    try {
      await api.importTitle(id);
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, isSaved: true } : t)));
      setNote('Added to library.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const from = (page - 1) * PER_PAGE + 1;
  const shown =
    items.length === 0
      ? 'No results'
      : total
        ? `${from.toLocaleString()}–${(from + items.length - 1).toLocaleString()} of ${total.toLocaleString()}`
        : `${items.length} result${items.length === 1 ? '' : 's'}`;

  return (
    <div>
      <div className="filterbar">
        <input
          ref={searchRef}
          className="search"
          placeholder="Search titles…   (press / )"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {sources.length > 1 && (
          <select
            className="select"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            title="Where to search for titles"
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <div className="chips">
          {LANGS.map((l) => (
            <button
              key={l.key}
              className={`chip ${lang === l.key ? 'active' : ''}`}
              onClick={() => setLang(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {note && <div className="notice" style={{ marginBottom: 16 }}>{note}</div>}
      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="result-line">
        {loading ? 'Searching…' : shown}
        {pages > 1 && <span className="muted"> · page {page} of {pages.toLocaleString()}</span>}
      </div>

      {loading ? (
        <div className="grid">
          {Array.from({ length: PER_PAGE }, (_, i) => (
            <div key={i} className="card skeleton-card">
              <div className="card-cover skeleton" />
              <div className="card-body">
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line short" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 && !error ? (
        <div className="empty">
          {page > 1
            ? `Nothing on page ${page}. This source stops returning results before its reported total.`
            : 'No titles found. Try a different search or another source.'}
        </div>
      ) : (
        <div className="grid">
          {items.map((t) => (
            <TitleCard key={t.id} item={t} busy={busy === t.id} onAdd={add} />
          ))}
        </div>
      )}

      <Pagination page={page} pages={pages} hasMore={hasMore} onChange={goTo} />
    </div>
  );
}

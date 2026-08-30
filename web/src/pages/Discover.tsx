import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DiscoverItem } from '../types';
import TitleCard from '../components/TitleCard';
import { useDebounce } from '../hooks';

const LANGS = [
  { key: '', label: 'All' },
  { key: 'ja', label: '🇯🇵 Manga' },
  { key: 'ko', label: '🇰🇷 Manhwa' },
];

export default function Discover() {
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q, 400);
  const [lang, setLang] = useState('');
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .discover({ q: debouncedQ, lang, page: 1, limit: 30 })
      .then((res) => {
        if (cancelled) return;
        setItems(res.titles);
        setTotal(res.total);
        setPage(1);
      })
      .catch((e) => setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, lang]);

  async function loadMore() {
    setLoading(true);
    try {
      const res = await api.discover({ q: debouncedQ, lang, page: page + 1, limit: 30 });
      setItems((prev) => [...prev, ...res.titles]);
      setPage(res.page);
      setTotal(res.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
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

  return (
    <div>
      <div className="toolbar">
        <input
          className="search"
          placeholder="Search manga / manhwa title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
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

      {loading && page === 1 && <div className="loading"><span className="spinner" />Loading…</div>}

      {!loading && items.length === 0 && !error && (
        <div className="empty">No titles found. Try a different search.</div>
      )}

      <div className="grid">
        {items.map((t) => (
          <TitleCard key={t.id} item={t} busy={busy === t.id} onAdd={add} />
        ))}
      </div>

      {items.length > 0 && items.length < total && (
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button className="btn primary" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : `Load more (${items.length}/${total})`}
          </button>
        </div>
      )}
    </div>
  );
}
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { DiscoverItem, SearchSort, SourceInfo, Tag } from '../types';
import TitleCard from '../components/TitleCard';
import Pagination from '../components/Pagination';
import { useDebounce } from '../hooks';

const LANGS = [
  { key: '', label: 'All' },
  { key: 'ja', label: '🇯🇵 Manga' },
  { key: 'ko', label: '🇰🇷 Manhwa' },
];

const SORTS: { key: SearchSort; label: string }[] = [
  { key: 'popular', label: 'Most followed' },
  { key: 'latest', label: 'Recently updated' },
  { key: 'newest', label: 'Recently added' },
  { key: 'rating', label: 'Top rated' },
  { key: 'title', label: 'Title A–Z' },
];

const PER_PAGE = 30;
const TAG_GROUPS = ['genre', 'theme', 'format'];

export default function Browse() {
  // Filters live in the URL: shelves and genre chips link straight here, and
  // the back button walks the search history rather than resetting it.
  const [params, setParams] = useSearchParams();
  const source = params.get('source') ?? '';
  const lang = params.get('lang') ?? '';
  const sort = (params.get('sort') as SearchSort | null) ?? '';
  const createdSince = params.get('since') ?? '';
  const tagParam = params.get('tags') ?? '';
  const selectedTags = useMemo(() => tagParam.split(',').filter(Boolean), [tagParam]);
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const urlQ = params.get('q') ?? '';

  const [q, setQ] = useState(urlQ);
  const debouncedQ = useDebounce(q, 400);

  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [showTags, setShowTags] = useState(selectedTags.length > 0);

  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /** Writes filters back to the URL, resetting the page unless it is the change. */
  function update(next: Record<string, string | null>, keepPage = false) {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    if (!keepPage) merged.delete('page');
    setParams(merged, { replace: true });
  }

  useEffect(() => {
    api.sources().then(
      (r) => setSources(r.sources),
      () => setSources([]),
    );
  }, []);

  const activeSource = source || sources[0]?.id || '';
  const sourceInfo = sources.find((s) => s.id === activeSource);
  const hasTags = sourceInfo?.hasTags === true;

  useEffect(() => {
    if (!hasTags) {
      setTags([]);
      return;
    }
    api.tags(activeSource).then(
      (r) => setTags(r.tags),
      () => setTags([]),
    );
  }, [activeSource, hasTags]);

  // Typing updates the URL once the input settles.
  useEffect(() => {
    if (debouncedQ !== urlQ) update({ q: debouncedQ || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const filterKey = `${activeSource}|${lang}|${sort}|${createdSince}|${tagParam}|${urlQ}`;
  useEffect(() => {
    setPages(0);
  }, [filterKey]);

  useEffect(() => {
    if (!activeSource) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .discover({
        q: urlQ,
        lang,
        source: activeSource,
        tags: selectedTags,
        sort: (sort || undefined) as SearchSort | undefined,
        createdSince: createdSince || undefined,
        page,
        limit: PER_PAGE,
      })
      .then((res) => {
        if (cancelled) return;
        setItems(res.titles);
        setTotal(res.total);
        // MangaDex reports a smaller `total` at deep offsets than at offset 0,
        // which would shrink the pager mid-browse and lose the user's place.
        setPages((prev) => Math.max(prev, res.pages));
        setHasMore(res.hasMore);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filterKey, page, activeSource, lang, sort, createdSince, selectedTags, urlQ]);

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
    update({ page: String(next) }, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleTag(id: string) {
    const next = selectedTags.includes(id)
      ? selectedTags.filter((t) => t !== id)
      : [...selectedTags, id];
    update({ tags: next.join(',') || null });
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
  const tagsByGroup = TAG_GROUPS.map((group) => ({
    group,
    tags: tags.filter((t) => t.group === group),
  })).filter((g) => g.tags.length > 0);
  const activeNames = selectedTags
    .map((id) => tags.find((t) => t.id === id)?.name)
    .filter(Boolean) as string[];

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
            value={activeSource}
            onChange={(e) => update({ source: e.target.value, tags: null })}
            title="Where to search for titles"
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <select
          className="select"
          value={sort}
          onChange={(e) => update({ sort: e.target.value || null, since: null })}
          title="Order results by"
        >
          <option value="">{urlQ ? 'Best match' : 'Most followed'}</option>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="chips">
          {LANGS.map((l) => (
            <button
              key={l.key}
              className={`chip ${lang === l.key ? 'active' : ''}`}
              onClick={() => update({ lang: l.key || null })}
            >
              {l.label}
            </button>
          ))}
        </div>
        {hasTags && (
          <button className="chip" onClick={() => setShowTags((v) => !v)}>
            Genres{selectedTags.length > 0 ? ` (${selectedTags.length})` : ''} {showTags ? '▴' : '▾'}
          </button>
        )}
      </div>

      {showTags && tagsByGroup.length > 0 && (
        <div className="tag-panel">
          {tagsByGroup.map(({ group, tags: groupTags }) => (
            <div key={group} className="tag-group">
              <div className="tag-group-label">{group}</div>
              <div className="chips wrap">
                {groupTags.map((t) => (
                  <button
                    key={t.id}
                    className={`chip tiny ${selectedTags.includes(t.id) ? 'active' : ''}`}
                    onClick={() => toggleTag(t.id)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {selectedTags.length > 0 && (
            <button className="btn small" onClick={() => update({ tags: null })}>
              Clear {selectedTags.length} filter{selectedTags.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {note && <div className="notice" style={{ marginBottom: 16 }}>{note}</div>}
      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="result-line">
        {loading ? 'Searching…' : shown}
        {pages > 1 && (
          <span className="muted">
            {' '}
            · page {page} of {pages.toLocaleString()}
          </span>
        )}
        {activeNames.length > 0 && <span className="muted"> · {activeNames.join(' + ')}</span>}
        {createdSince && <span className="muted"> · added recently</span>}
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
            : 'No titles found. Try a different search, fewer genres, or another source.'}
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

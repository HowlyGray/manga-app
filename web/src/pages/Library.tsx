import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatBytes } from '../format';
import type { LibraryTitle, Usage } from '../types';
import { useUpdates } from '../updates';

type Sort = 'default' | 'new' | 'title' | 'progress' | 'downloaded';

const SORTS: { key: Sort; label: string }[] = [
  { key: 'default', label: 'Recently added' },
  { key: 'new', label: 'New chapters first' },
  { key: 'progress', label: 'In progress first' },
  { key: 'title', label: 'Title A–Z' },
  { key: 'downloaded', label: 'Most downloaded' },
];

function LibraryCard({ t, size }: { t: LibraryTitle; size?: number }) {
  const pct = t.total_chapters > 0 ? Math.round((t.downloaded_chapters / t.total_chapters) * 100) : 0;
  // Only for series being read: every chapter of an untouched one is "unread".
  const unread = Math.max(0, t.total_chapters - t.read_chapters);
  const readingBadge = t.progress_chapter_id ? (unread > 0 ? `${unread} unread` : '✓ Caught up') : null;
  const meta = [
    (t.original_lang ?? '').toUpperCase() || null,
    t.year,
    t.jikan_score != null ? `★ ${t.jikan_score}` : null,
    size ? formatBytes(size) : null,
  ].filter(Boolean);

  return (
    <article className="card">
      <Link to={`/library/${t.id}`} className="card-link" title={t.title}>
        <div className="card-cover-wrap">
          <img
            className="card-cover"
            src={`/api/cover/${encodeURIComponent(t.id)}`}
            alt=""
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
          {t.new_chapters > 0 && (
            <span className="card-badge upper badge-new">{t.new_chapters} new</span>
          )}
          {readingBadge && <span className="card-badge badge-reading">{readingBadge}</span>}
        </div>
        <div className="card-body">
          <h3 className="card-title">{t.title}</h3>
          {meta.length > 0 && <div className="card-meta">{meta.join(' · ')}</div>}
          <div className="card-progress" title={`${t.downloaded_chapters} of ${t.total_chapters} chapters downloaded`}>
            <div className="card-progress-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <span className="card-meta">
              {t.downloaded_chapters}/{t.total_chapters}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export default function Library() {
  const [titles, setTitles] = useState<LibraryTitle[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('default');
  /** The check for new chapters runs from the moment the app opens; this page only shows it. */
  const { check, finished, checkNow } = useUpdates();
  /** The button was pressed here, so even "nothing new" deserves an answer. */
  const [asked, setAsked] = useState(false);
  /** Bytes on disk per title, and in total. */
  const [sizes, setSizes] = useState<Map<string, number>>(new Map());
  const [onDisk, setOnDisk] = useState<Usage | null>(null);

  // Measured separately so walking a large library does not hold up the list.
  useEffect(() => {
    api.libraryUsage().then(
      (usage) => {
        setSizes(new Map(usage.titles.map((t) => [t.id, t.pages + t.translations + t.ocr])));
        setOnDisk(usage.total);
      },
      () => {},
    );
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setTitles(await api.library());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // A check that ends while this page is open has changed what the cards say.
  useEffect(() => {
    if (finished > 0) void refresh();
  }, [finished]);

  async function checkUpdates() {
    setError('');
    setAsked(true);
    try {
      await checkNow();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const shown = useMemo(() => {
    if (!titles) return [];
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? titles.filter((t) => t.title.toLowerCase().includes(needle))
      : [...titles];
    switch (sort) {
      case 'new':
        return list.sort((a, b) => b.new_chapters - a.new_chapters);
      case 'title':
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case 'downloaded':
        return list.sort((a, b) => b.downloaded_chapters - a.downloaded_chapters);
      case 'progress':
        return list.sort(
          (a, b) => Number(Boolean(b.progress_chapter_id)) - Number(Boolean(a.progress_chapter_id)),
        );
      default:
        return list;
    }
  }, [titles, filter, sort]);

  const reading = useMemo(() => (titles ?? []).filter((t) => t.progress_chapter_id), [titles]);

  if (error) return <div className="error">{error}</div>;
  if (!titles) {
    return (
      <div className="grid">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="card skeleton-card">
            <div className="card-cover skeleton" />
            <div className="card-body">
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (titles.length === 0) {
    return (
      <div className="empty">
        <p>Your library is empty.</p>
        <p>Browse the Discover tab and add a series — chapters download locally.</p>
        <p>
          <Link to="/">
            <button className="btn primary">Go to Discover</button>
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      {reading.length > 0 && filter === '' && (
        <section className="shelf">
          <h2 className="shelf-title">Continue reading</h2>
          <div className="grid">
            {reading.map((t) => (
              <LibraryCard key={`reading-${t.id}`} t={t} size={sizes.get(t.id)} />
            ))}
          </div>
        </section>
      )}

      <div className="filterbar">
        <h2 className="shelf-title" style={{ margin: 0 }}>
          Library <span className="muted">({titles.length})</span>
        </h2>
        <input
          className="search"
          placeholder="Filter your library…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
        <button
          className="btn small"
          onClick={checkUpdates}
          disabled={check?.running}
          title="Look for new chapters in every title now. This also happens by itself when the app opens."
        >
          {check?.running ? `Checking ${check.checked}/${check.total}…` : 'Check for new chapters'}
        </button>
      </div>

      {onDisk && onDisk.pages + onDisk.translations + onDisk.ocr > 0 && (
        <div className="result-line">
          On disk: {formatBytes(onDisk.pages)} of pages · {formatBytes(onDisk.translations)} of translations
          {onDisk.ocr > 0 ? ` · ${formatBytes(onDisk.ocr)} of OCR` : ''}
          <span className="muted"> — clear a title's translations or remove it from its page</span>
        </div>
      )}

      {check && !check.running && check.finishedAt && (asked || check.found > 0 || check.failed.length > 0) && (
        <div className="notice" style={{ marginBottom: 16 }}>
          {check.found > 0
            ? `Found ${check.found} new chapter${check.found === 1 ? '' : 's'}.`
            : 'No new chapters.'}
          {check.failed.length > 0 && (
            <span title={check.failed.map((f) => `${f.title}: ${f.error}`).join('\n')}>
              {' '}
              {check.failed.length} title{check.failed.length === 1 ? '' : 's'} could not be checked.
            </span>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="empty">No title matches that filter.</div>
      ) : (
        <div className="grid">
          {shown.map((t) => (
            <LibraryCard key={t.id} t={t} size={sizes.get(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

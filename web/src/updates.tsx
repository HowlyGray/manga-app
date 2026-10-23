import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import type { UpdateCheck } from './types';

interface Updates {
  /** The check this page started or found running; the last to finish after that. */
  check: UpdateCheck | null;
  /** Counts up each time a watched check ends, so pages know to reload what they show. */
  finished: number;
  /** Looks for new chapters in every saved title now, however recently each was checked. */
  checkNow: () => Promise<void>;
}

const UpdatesContext = createContext<Updates | null>(null);

export function useUpdates(): Updates {
  const value = useContext(UpdatesContext);
  if (!value) throw new Error('useUpdates needs an UpdatesProvider');
  return value;
}

/**
 * Looks for new chapters as soon as the app is opened, whichever page it opens
 * on. Titles checked recently are left alone by the server, so opening the app
 * again an hour later costs nothing; what a check turns up shows as badges in
 * the library and in the top bar.
 */
export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [finished, setFinished] = useState(0);
  const running = check?.running === true;

  useEffect(() => {
    let alive = true;
    api.checkUpdates({ stale: true }).then(
      (job) => alive && job.running && setCheck(job),
      () => {
        /* the server is unreachable; the pages say so themselves */
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Follow a running check until it ends.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      const status = await api.updateCheckStatus().catch(() => null);
      if (!status) return;
      setCheck(status);
      if (!status.running) setFinished((n) => n + 1);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [running]);

  const checkNow = useCallback(async () => {
    setCheck(await api.checkUpdates());
  }, []);

  const value = useMemo(() => ({ check, finished, checkNow }), [check, finished, checkNow]);
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

/**
 * The top bar's word on the check: how far along it is while it runs, and for
 * half a minute afterwards what it found, linking to the library.
 */
export function UpdateChip() {
  const { check } = useUpdates();
  const finishedAt = check?.finishedAt ?? null;
  const [stale, setStale] = useState(false);

  useEffect(() => {
    setStale(false);
    if (!finishedAt) return;
    const timer = window.setTimeout(() => setStale(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [finishedAt]);

  if (!check) return null;
  if (check.running) {
    return (
      <span className="update-chip" role="status" title="Looking for new chapters in your library">
        <span className="spinner" />
        <span className="update-chip-label">Looking for new chapters… </span>
        {check.checked}/{check.total}
      </span>
    );
  }
  if (stale || check.found === 0) return null;
  return (
    <Link to="/library" className="update-chip found" role="status">
      {check.found} new
      <span className="update-chip-label"> chapter{check.found === 1 ? '' : 's'}</span>
    </Link>
  );
}

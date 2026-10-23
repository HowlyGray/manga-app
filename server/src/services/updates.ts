/**
 * Keeping the library current.
 *
 * New chapters used to appear only when someone opened a title and pressed
 * "Sync metadata", or pressed "Check for new chapters" on the library page. The
 * server now looks by itself: shortly after it starts, every so often while it
 * runs, and whenever the web app is opened. A title is only looked at again
 * once its last check is old enough, so opening the app five times in an hour
 * costs one check.
 *
 * Titles are checked one at a time within a source, since each source client
 * rate-limits its own requests, and the sources run side by side. New chapters
 * show as a badge in the library until the title is opened.
 */
import { config } from '../config';
import { refreshTitle } from './ingest';
import * as lib from './library';

export interface UpdateCheck {
  running: boolean;
  total: number;
  checked: number;
  /** New chapters found, counted the way the library badges count them. */
  found: number;
  failed: { id: string; title: string; error: string }[];
  startedAt: string;
  finishedAt: string | null;
}

export interface UpdateOptions {
  /** Only titles last checked longer ago than this; every title when omitted. */
  olderThanMs?: number;
}

let current: UpdateCheck | null = null;

/** Titles that failed lately, so a source that is down is not asked again at every trigger. */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 10 * 60_000;

/** A source that fails this many titles in a row is down, not picky about one. */
const GIVE_UP_AFTER = 3;

/** The running check, or the last one to finish; null before the first. */
export function updateCheckStatus(): UpdateCheck | null {
  return current;
}

/**
 * Starts a check unless one is already running, and returns it. When nothing is
 * due the answer is a finished check of no titles, which is not kept as "the
 * last check": it would hide the result of the one that did the work.
 */
export function startUpdateCheck(opts: UpdateOptions = {}): UpdateCheck {
  if (current?.running) return current;

  const now = Date.now();
  // Only an automatic check holds back titles that just failed; asking by hand always tries.
  const due = lib
    .titlesToCheck(opts.olderThanMs)
    .filter((t) => opts.olderThanMs == null || now - (failedAt.get(t.id) ?? 0) > RETRY_AFTER_MS);

  const job: UpdateCheck = {
    running: due.length > 0,
    total: due.length,
    checked: 0,
    found: 0,
    failed: [],
    startedAt: new Date(now).toISOString(),
    finishedAt: due.length > 0 ? null : new Date(now).toISOString(),
  };
  if (due.length === 0) return job;
  current = job;

  const lanes = new Map<string, lib.TitleToCheck[]>();
  for (const t of due) lanes.set(t.provider, [...(lanes.get(t.provider) ?? []), t]);

  void Promise.all([...lanes.values()].map((titles) => checkLane(titles, job)))
    .catch((err: unknown) => console.warn(`[updates] check stopped: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      console.log(
        `[updates] checked ${job.checked} title${job.checked === 1 ? '' : 's'}: ` +
          `${job.found} new chapter${job.found === 1 ? '' : 's'}, ${job.failed.length} failed`,
      );
    });
  return job;
}

/** One source's titles, in turn. */
async function checkLane(titles: lib.TitleToCheck[], job: UpdateCheck): Promise<void> {
  let failures = 0;
  for (const [i, t] of titles.entries()) {
    try {
      job.found += (await refreshTitle(t.id)).news;
      failedAt.delete(t.id);
      failures = 0;
    } catch (err) {
      failedAt.set(t.id, Date.now());
      job.failed.push({ id: t.id, title: t.title, error: err instanceof Error ? err.message : String(err) });
      if (++failures >= GIVE_UP_AFTER) {
        // Each failure can already have waited out several retries; another
        // dozen titles would only repeat that against a source that is down.
        for (const rest of titles.slice(i + 1)) {
          job.failed.push({ id: rest.id, title: rest.title, error: 'not tried: the source is not answering' });
          job.checked++;
        }
        job.checked++;
        return;
      }
    }
    job.checked++;
  }
}

/**
 * Starts the periodic checks: once shortly after the server is up, then every
 * `intervalMs`. Each one skips titles checked within `staleMs`, so a short
 * interval costs nothing on a library that is already current.
 */
export function scheduleUpdateChecks(): void {
  const { enabled, staleMs, intervalMs, startDelayMs } = config.updates;
  if (!enabled) return;
  const run = () => {
    try {
      startUpdateCheck({ olderThanMs: staleMs });
    } catch (err) {
      console.warn(`[updates] check failed to start: ${err instanceof Error ? err.message : err}`);
    }
  };
  // Neither timer should be the thing that keeps the process alive.
  setTimeout(run, startDelayMs).unref();
  setInterval(run, intervalMs).unref();
}

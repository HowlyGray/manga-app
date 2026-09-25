import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PageOverlay } from './types';

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export type OverlayState =
  | { status: 'loading' }
  | { status: 'ready'; overlay: PageOverlay }
  | { status: 'error'; message: string };

/**
 * Fetches page text-layers on demand, a couple at a time.
 *
 * The first request for a page runs OCR and translation server-side, so pages
 * ask for their own overlay as they come near the screen rather than the reader
 * pulling a whole chapter up front, and drop out of the queue if they scroll
 * away first. Results are cached on the server, so revisiting is immediate.
 *
 * Leaving the reader stops the queue. It used to keep draining after unmount,
 * translating (and paying for) the rest of a chapter nobody was reading.
 */
export function usePageOverlays(
  titleId: string | undefined,
  chapterId: string | undefined,
  target: string,
  concurrency = 2,
): {
  states: Map<number, OverlayState>;
  request: (pageNumber: number) => void;
  cancel: (pageNumber: number) => void;
  refresh: (pageNumber: number) => void;
} {
  const key = `${titleId ?? ''}|${chapterId ?? ''}|${target}`;
  const [states, setStates] = useState<Map<number, OverlayState>>(new Map());
  const [activeKey, setActiveKey] = useState(key);
  const queue = useRef<number[]>([]);
  const active = useRef(0);
  const seen = useRef<Set<number>>(new Set());
  /** Pages to re-read past the server cache, after a correction was saved. */
  const forced = useRef<Set<number>>(new Set());
  /** In-flight requests, aborted when the reader moves on. */
  const inFlight = useRef<Map<number, AbortController>>(new Map());
  const token = useRef(0);

  // Reset during render, not in an effect: React runs child effects before the
  // parent's, so an effect here would wipe the queue the pages had just filled
  // and no overlay would ever be fetched.
  if (activeKey !== key) {
    setActiveKey(key);
    setStates(new Map());
    token.current += 1;
    queue.current = [];
    active.current = 0;
    seen.current = new Set();
  }

  // On unmount, and when the chapter or target changes: drop the queue and
  // abort what is in flight. Bumping the token makes late replies no-ops.
  useEffect(
    () => () => {
      token.current += 1;
      queue.current = [];
      active.current = 0;
      seen.current = new Set();
      forced.current = new Set();
      for (const controller of inFlight.current.values()) controller.abort();
      inFlight.current = new Map();
    },
    [key],
  );

  const pump = useCallback(() => {
    if (!titleId || !chapterId || !target) return;
    const mine = token.current;
    while (active.current < concurrency && queue.current.length > 0) {
      const pageNumber = queue.current.shift()!;
      active.current += 1;
      const controller = new AbortController();
      inFlight.current.set(pageNumber, controller);
      api
        .pageOverlay(
          titleId,
          chapterId,
          pageNumber,
          target,
          forced.current.delete(pageNumber),
          controller.signal,
        )
        .then(
          (overlay): OverlayState => ({ status: 'ready', overlay }),
          (err: Error): OverlayState => ({ status: 'error', message: err.message }),
        )
        .then((state) => {
          if (token.current !== mine) return;
          setStates((prev) => new Map(prev).set(pageNumber, state));
        })
        .finally(() => {
          if (token.current !== mine) return;
          inFlight.current.delete(pageNumber);
          active.current -= 1;
          pump();
        });
    }
  }, [titleId, chapterId, target, concurrency]);

  const request = useCallback(
    (pageNumber: number) => {
      if (!titleId || !chapterId || !target) return;
      if (seen.current.has(pageNumber)) return;
      seen.current.add(pageNumber);
      setStates((prev) => new Map(prev).set(pageNumber, { status: 'loading' }));
      queue.current.push(pageNumber);
      pump();
    },
    [titleId, chapterId, target, pump],
  );

  /**
   * Takes a page back out of the queue when it scrolls away before its turn.
   * A request already running is left to finish: the server caches the result.
   */
  const cancel = useCallback((pageNumber: number) => {
    // A refresh after a correction must still happen, or the page would come
    // back showing the uncorrected text from the server cache.
    if (forced.current.has(pageNumber)) return;
    const at = queue.current.indexOf(pageNumber);
    if (at < 0) return;
    queue.current.splice(at, 1);
    seen.current.delete(pageNumber);
    setStates((prev) => {
      const next = new Map(prev);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  /** Re-reads one page, bypassing the cached overlay. Jumps the queue. */
  const refresh = useCallback(
    (pageNumber: number) => {
      if (!titleId || !chapterId || !target) return;
      forced.current.add(pageNumber);
      seen.current.add(pageNumber);
      setStates((prev) => new Map(prev).set(pageNumber, { status: 'loading' }));
      queue.current = [pageNumber, ...queue.current.filter((p) => p !== pageNumber)];
      pump();
    },
    [titleId, chapterId, target, pump],
  );

  return { states, request, cancel, refresh };
}

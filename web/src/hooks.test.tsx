import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageOverlay } from './types';

const { pageOverlay } = vi.hoisted(() => ({ pageOverlay: vi.fn() }));
vi.mock('./api', () => ({ api: { pageOverlay } }));

import { usePageOverlays } from './hooks';

const OVERLAY: PageOverlay = {
  v: 13,
  width: 1,
  height: 1,
  sourceLang: 'en',
  sourceLabel: 'English',
  targetLang: 'FR',
  engine: 'none',
  provider: 'none',
  translated: false,
  blocks: [],
};

/** Every overlay request, left pending until the test settles it. */
function holdRequests() {
  const pending: { page: number; refresh: boolean; signal: AbortSignal; settle: () => void }[] = [];
  pageOverlay.mockImplementation(
    (_t: string, _c: string, page: number, _target: string, refresh: boolean, signal: AbortSignal) =>
      new Promise<PageOverlay>((resolve) => {
        pending.push({ page, refresh, signal, settle: () => resolve(OVERLAY) });
      }),
  );
  return pending;
}

/** Settles one request and lets the queue react. */
async function settle(request: { settle: () => void }) {
  await act(async () => {
    request.settle();
  });
}

afterEach(() => {
  pageOverlay.mockReset();
});

describe('usePageOverlays', () => {
  it('runs two requests at a time', () => {
    const pending = holdRequests();
    const { result } = renderHook(() => usePageOverlays('t', 'c', 'FR'));
    act(() => {
      for (let p = 1; p <= 5; p++) result.current.request(p);
    });
    expect(pending.map((r) => r.page)).toEqual([1, 2]);
    expect(result.current.states.get(5)).toEqual({ status: 'loading' });
  });

  it('stops for good when the reader closes', async () => {
    const pending = holdRequests();
    const { result, unmount } = renderHook(() => usePageOverlays('t', 'c', 'FR'));
    act(() => {
      for (let p = 1; p <= 5; p++) result.current.request(p);
    });
    unmount();
    // The requests in flight are aborted...
    expect(pending.every((r) => r.signal.aborted)).toBe(true);
    // ...and finishing them no longer pulls pages 3-5 off the queue. Before the
    // fix this kept translating, and paying for, the rest of the chapter.
    await settle(pending[0]);
    await settle(pending[1]);
    expect(pageOverlay).toHaveBeenCalledTimes(2);
  });

  it('lets a queued page drop out when it scrolls away', async () => {
    const pending = holdRequests();
    const { result } = renderHook(() => usePageOverlays('t', 'c', 'FR'));
    act(() => {
      for (let p = 1; p <= 4; p++) result.current.request(p);
      result.current.cancel(3);
    });
    expect(result.current.states.has(3)).toBe(false);
    await settle(pending[0]);
    expect(pending.map((r) => r.page)).toEqual([1, 2, 4]);
  });

  it('puts a post-correction refresh first and never drops it', async () => {
    const pending = holdRequests();
    const { result } = renderHook(() => usePageOverlays('t', 'c', 'FR'));
    act(() => {
      for (let p = 1; p <= 4; p++) result.current.request(p);
      result.current.refresh(4);
      result.current.cancel(4);
    });
    await settle(pending[0]);
    expect(pending[2]).toMatchObject({ page: 4, refresh: true });
  });

  it('starts over when the chapter changes', () => {
    const pending = holdRequests();
    const { result, rerender } = renderHook(({ chapter }) => usePageOverlays('t', chapter, 'FR'), {
      initialProps: { chapter: 'c1' },
    });
    act(() => {
      result.current.request(1);
    });
    rerender({ chapter: 'c2' });
    expect(pending[0].signal.aborted).toBe(true);
    act(() => {
      result.current.request(1);
    });
    expect(pageOverlay).toHaveBeenLastCalledWith('t', 'c2', 1, 'FR', false, expect.any(AbortSignal));
  });
});

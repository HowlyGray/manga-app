import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheck } from './types';

const { checkUpdates, updateCheckStatus } = vi.hoisted(() => ({
  checkUpdates: vi.fn(),
  updateCheckStatus: vi.fn(),
}));
vi.mock('./api', () => ({ api: { checkUpdates, updateCheckStatus } }));

import { UpdateChip, UpdatesProvider, useUpdates } from './updates';

const job = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  running: true,
  total: 4,
  checked: 0,
  found: 0,
  failed: [],
  startedAt: '2026-10-23T10:00:00.000Z',
  finishedAt: null,
  ...over,
});

const finishedJob = (found: number) =>
  job({ running: false, checked: 4, found, finishedAt: '2026-10-23T10:00:09.000Z' });

/** What a page sees of the check, as text. */
function Probe() {
  const { check, finished, checkNow } = useUpdates();
  const state = !check ? 'none' : check.running ? `running ${check.checked}/${check.total}` : `done ${check.found}`;
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="finished">{finished}</span>
      <button onClick={() => void checkNow()}>check now</button>
    </div>
  );
}

async function mount() {
  render(
    <MemoryRouter>
      <UpdatesProvider>
        <UpdateChip />
        <Probe />
      </UpdatesProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Not automatic here: this suite does not run with Vitest globals.
  cleanup();
  vi.useRealTimers();
  checkUpdates.mockReset();
  updateCheckStatus.mockReset();
});

describe('looking for new chapters when the app opens', () => {
  it('asks for the titles that are due, and stays quiet when none is', async () => {
    checkUpdates.mockResolvedValue(job({ running: false, total: 0, finishedAt: '2026-10-23T10:00:00.000Z' }));
    await mount();
    expect(checkUpdates).toHaveBeenCalledWith({ stale: true });
    expect(screen.getByTestId('state').textContent).toBe('none');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('follows a running check, then says what it found', async () => {
    checkUpdates.mockResolvedValue(job());
    updateCheckStatus
      .mockResolvedValueOnce(job({ checked: 2 }))
      .mockResolvedValue(finishedJob(3));
    await mount();
    expect(screen.getByRole('status').textContent).toContain('0/4');

    await tick(1500);
    expect(screen.getByTestId('state').textContent).toBe('running 2/4');
    expect(screen.getByRole('status').textContent).toContain('2/4');
    expect(screen.getByTestId('finished').textContent).toBe('0');

    await tick(1500);
    expect(screen.getByTestId('state').textContent).toBe('done 3');
    // Pages reload what they show when this changes.
    expect(screen.getByTestId('finished').textContent).toBe('1');
    expect(screen.getByRole('status').textContent).toBe('3 new chapters');
    expect(screen.getByRole('status').getAttribute('href')).toBe('/library');

    // It is news for half a minute, not for good.
    await tick(30_000);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not announce a check that found nothing', async () => {
    checkUpdates.mockResolvedValue(job());
    updateCheckStatus.mockResolvedValue(finishedJob(0));
    await mount();
    await tick(1500);
    expect(screen.getByTestId('finished').textContent).toBe('1');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps going when the server does not answer a poll', async () => {
    checkUpdates.mockResolvedValue(job());
    updateCheckStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(finishedJob(1));
    await mount();
    await tick(1500);
    expect(screen.getByTestId('state').textContent).toBe('running 0/4');
    await tick(1500);
    expect(screen.getByTestId('state').textContent).toBe('done 1');
  });
});

describe('checking by hand', () => {
  it('asks for every title, not just the due ones', async () => {
    checkUpdates.mockResolvedValue(job({ running: false, total: 0 }));
    await mount();
    checkUpdates.mockResolvedValue(job({ total: 14 }));
    fireEvent.click(screen.getByText('check now'));
    await act(async () => {});
    expect(checkUpdates).toHaveBeenLastCalledWith();
    expect(screen.getByTestId('state').textContent).toBe('running 0/14');
  });
});

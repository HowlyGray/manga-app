import { describe, expect, it } from 'vitest';
import { formatBytes, timeAgo } from './format';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();

describe('timeAgo', () => {
  it('speaks in the largest unit that fits', () => {
    expect(timeAgo(before(20_000), NOW)).toBe('just now');
    expect(timeAgo(before(5 * 60_000), NOW)).toBe('5 min ago');
    expect(timeAgo(before(3 * 3600_000 + 59 * 60_000), NOW)).toBe('3 h ago');
    expect(timeAgo(before(26 * 3600_000), NOW)).toBe('1 d ago');
    expect(timeAgo(before(9 * 24 * 3600_000), NOW)).toBe('9 d ago');
  });

  it('has nothing to say without a usable time', () => {
    expect(timeAgo(null, NOW)).toBeNull();
    expect(timeAgo(undefined, NOW)).toBeNull();
    expect(timeAgo('yesterday-ish', NOW)).toBeNull();
  });

  it('never reports a time in the future', () => {
    expect(timeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('formatBytes', () => {
  it('scales up to the unit that keeps the number short', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(734003200)).toBe('700 MB');
  });
});

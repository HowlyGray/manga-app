import { describe, expect, it } from 'vitest';
import { RateLimiter, sleep } from '../src/util/net';

describe('RateLimiter', () => {
  it('acquire() spaces out start times but lets the work overlap', async () => {
    const limiter = new RateLimiter(40);
    let inFlight = 0;
    let peak = 0;
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        await limiter.acquire();
        starts.push(Date.now() - t0);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(200);
        inFlight--;
      }),
    );
    // The downloader used to wrap the whole download in run(), which made
    // MDX_IMAGE_CONCURRENCY effectively 1.
    expect(peak).toBe(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(30);
  });

  it('run() still serializes, so a backing-off API call holds the others', async () => {
    const limiter = new RateLimiter(0);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(20);
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
});

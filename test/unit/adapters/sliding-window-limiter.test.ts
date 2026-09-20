import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../../../src/adapters/http/sliding-window-limiter.js';
import { FakeClock } from '../../support/fake-clock.js';

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit, then refuses with an accurate retry hint', () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(3, 60_000, clock.now);

    expect(limiter.hit('alice').allowed).toBe(true);
    clock.advance(10_000);
    expect(limiter.hit('alice').allowed).toBe(true);
    expect(limiter.hit('alice').allowed).toBe(true);

    // Oldest hit was 10 s ago, so it leaves the window in 50 s.
    expect(limiter.hit('alice')).toEqual({ allowed: false, retryAfterSeconds: 50 });
  });

  it('frees a slot as the oldest hit leaves the window', () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(2, 60_000, clock.now);
    limiter.hit('alice');
    clock.advance(30_000);
    limiter.hit('alice');
    expect(limiter.hit('alice').allowed).toBe(false);

    clock.advance(30_000); // first hit is now exactly one window old
    expect(limiter.hit('alice').allowed).toBe(true);
    expect(limiter.hit('alice').allowed).toBe(false);
  });

  it('refused requests do not extend the penalty', () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(1, 60_000, clock.now);
    limiter.hit('alice');
    for (let i = 0; i < 20; i += 1) limiter.hit('alice');
    clock.advance(60_000);
    expect(limiter.hit('alice').allowed).toBe(true);
  });

  it('keeps callers independent', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, new FakeClock().now);
    expect(limiter.hit('alice').allowed).toBe(true);
    expect(limiter.hit('bob').allowed).toBe(true);
    expect(limiter.hit('alice').allowed).toBe(false);
  });

  it('never suggests retrying in less than a second', () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(1, 60_000, clock.now);
    limiter.hit('a');
    clock.advance(59_999);
    expect(limiter.hit('a').retryAfterSeconds).toBe(1);
  });

  it('sweep drops idle keys (bounded memory) but keeps active ones', () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(1, 60_000, clock.now);
    limiter.hit('idle');
    clock.advance(59_000);
    limiter.hit('active');
    clock.advance(2_000); // idle is now outside the window, active is not

    limiter.sweep();

    // Tracked keys are an implementation detail, but unbounded growth is the bug being guarded.
    const tracked = (limiter as unknown as { hitsByKey: Map<string, number[]> }).hitsByKey;
    expect([...tracked.keys()]).toEqual(['active']);
    expect(limiter.hit('active').allowed).toBe(false);
  });
});

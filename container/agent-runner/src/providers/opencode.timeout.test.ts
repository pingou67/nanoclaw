import { describe, it, expect } from 'bun:test';

import { checkIdleTimeout } from './opencode.js';

describe('checkIdleTimeout', () => {
  it('returns not-timed-out when the stream has been recently active', () => {
    let returned = false;
    const stream = { return: () => { returned = true; } };
    const r = checkIdleTimeout(Date.now() - 100, false, 300_000, stream);
    expect(r.timedOut).toBe(false);
    expect(r.eventTimedOut).toBe(false);
    expect(returned).toBe(false);
  });

  it('returns timed-out and releases the stream when idle exceeds the threshold', () => {
    let returned = false;
    const stream = { return: () => { returned = true; } };
    const r = checkIdleTimeout(Date.now() - 600_000, false, 300_000, stream);
    expect(r.timedOut).toBe(true);
    expect(r.eventTimedOut).toBe(true);
    expect(returned).toBe(true);
  });

  it('is idempotent: a second call after the first timeout does NOT re-release the stream', () => {
    let returnCount = 0;
    const stream = { return: () => { returnCount++; } };
    const r1 = checkIdleTimeout(Date.now() - 600_000, false, 300_000, stream);
    expect(r1.timedOut).toBe(true);
    expect(returnCount).toBe(1);
    // The setInterval would keep firing every 5s; without idempotence,
    // this is what causes the timeout log to spam indefinitely.
    const r2 = checkIdleTimeout(Date.now() - 605_000, r1.eventTimedOut, 300_000, stream);
    expect(r2.timedOut).toBe(false);
    expect(returnCount).toBe(1);
    const r3 = checkIdleTimeout(Date.now() - 610_000, r2.eventTimedOut, 300_000, stream);
    expect(r3.timedOut).toBe(false);
    expect(returnCount).toBe(1);
  });

  it('tolerates a stream without a return() method', () => {
    const r = checkIdleTimeout(Date.now() - 600_000, false, 300_000, undefined);
    expect(r.timedOut).toBe(true);
    expect(r.eventTimedOut).toBe(true);
  });
});

/**
 * The cooldown is the whole security value of this script: a version published
 * hours ago must never be proposed, however new it is. These tests pin that
 * behaviour so a refactor can't quietly turn the check into "always latest".
 */
import { describe, expect, it } from 'vitest';

import { compareVersions, pickEligibleVersion } from './check-cli-tools.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('compareVersions', () => {
  it('orders numerically, not lexicographically', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.1.11', '1.1.2')).toBeGreaterThan(0);
    expect(compareVersions('2.6.2', '2.6.2')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('2.6', '2.6.0')).toBe(0);
    expect(compareVersions('2.6', '2.6.1')).toBeLessThan(0);
  });
});

describe('pickEligibleVersion', () => {
  it('ignores anything published inside the cooldown window', () => {
    const picked = pickEligibleVersion(
      { created: daysAgo(400), '1.0.0': daysAgo(30), '1.1.0': daysAgo(1) },
      NOW,
      3,
    );
    expect(picked?.version).toBe('1.0.0');
  });

  it('accepts a version exactly at the cooldown boundary', () => {
    const picked = pickEligibleVersion({ '1.0.0': daysAgo(30), '1.1.0': daysAgo(3) }, NOW, 3);
    expect(picked?.version).toBe('1.1.0');
  });

  it('skips prereleases even when they are old enough', () => {
    const picked = pickEligibleVersion(
      { '1.0.0': daysAgo(30), '2.0.0-beta.1': daysAgo(20), '2.0.0-rc.2': daysAgo(10) },
      NOW,
      3,
    );
    expect(picked?.version).toBe('1.0.0');
  });

  it('returns the highest eligible version, not the most recently published', () => {
    // A 1.x patch released after 2.0.0 must not shadow it.
    const picked = pickEligibleVersion({ '2.0.0': daysAgo(30), '1.9.9': daysAgo(5) }, NOW, 3);
    expect(picked?.version).toBe('2.0.0');
  });

  it('returns null when every version is still inside the window', () => {
    expect(pickEligibleVersion({ '1.0.0': daysAgo(1) }, NOW, 3)).toBeNull();
  });

  it('never treats the registry bookkeeping keys as versions', () => {
    const picked = pickEligibleVersion({ created: daysAgo(400), modified: daysAgo(1), '1.0.0': daysAgo(30) }, NOW, 3);
    expect(picked?.version).toBe('1.0.0');
  });
});

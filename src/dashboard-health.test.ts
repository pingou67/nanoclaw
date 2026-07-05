import { describe, expect, it } from 'vitest';

import { classifyClaudeExpiry, containerPathToHost, healthLogLines } from './dashboard-health.js';

describe('classifyClaudeExpiry', () => {
  const now = 1_700_000_000_000;

  it('reports error when the token is expired', () => {
    const check = classifyClaudeExpiry(now - 5 * 60_000, now);
    expect(check.status).toBe('error');
    expect(check.detail).toContain('expiré');
  });

  it('warns when the token expires within 90 minutes', () => {
    const check = classifyClaudeExpiry(now + 30 * 60_000, now);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('30 min');
  });

  it('is ok when the token has hours left', () => {
    const check = classifyClaudeExpiry(now + 8 * 3_600_000, now);
    expect(check.status).toBe('ok');
  });
});

describe('containerPathToHost', () => {
  it('maps /workspace/agent/ paths into the group folder', () => {
    const p = containerPathToHost('mattermost_agc', '/workspace/agent/google-oauth/gmail-token.json');
    expect(p).toMatch(/groups\/mattermost_agc\/google-oauth\/gmail-token\.json$/);
  });

  it('returns null for paths outside the group dir', () => {
    expect(containerPathToHost('g', '/tmp/whatever.json')).toBeNull();
    expect(containerPathToHost('g', 'relative.json')).toBeNull();
  });
});

describe('healthLogLines', () => {
  it('emits a startup summary, then lines only on status change', () => {
    const first = healthLogLines([
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'error', detail: 'broken' },
    ]);
    // startup: no OK spam, but the error and the summary line show up
    expect(first.some((l) => l.includes('ERROR b'))).toBe(true);
    expect(first.some((l) => l.includes('démarrage'))).toBe(true);
    expect(first.some((l) => l.includes('a:'))).toBe(false);

    // unchanged statuses → silence
    const second = healthLogLines([
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'error', detail: 'broken' },
    ]);
    expect(second).toEqual([]);

    // recovery b error→ok produces an INFO line
    const third = healthLogLines([
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'ok', detail: 'repaired' },
    ]);
    expect(third).toHaveLength(1);
    expect(third[0]).toContain('INFO b: repaired');

    // info-level checks never log
    const fourth = healthLogLines([{ name: 'rtk-savings', status: 'info', detail: 'x' }]);
    expect(fourth).toEqual([]);
  });
});

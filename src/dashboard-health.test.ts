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

  // Un credential mutualisé vit sur un mount, pas dans le dossier du groupe.
  // Ne résoudre que /workspace/agent/ laissait ce cas hors surveillance pour
  // TOUS les groupes concernés, sans que rien ne devienne rouge.
  it('résout un chemin servi par un mount (containerPath relatif)', () => {
    const p = containerPathToHost('mattermost_dm', '/workspace/extra/google-mcp/gcp-oauth.keys.json', [
      { hostPath: '/home/u/.google-mcp', containerPath: 'google-mcp' },
    ]);
    expect(p).toBe('/home/u/.google-mcp/gcp-oauth.keys.json');
  });

  it('résout aussi un mount déclaré en chemin absolu', () => {
    const p = containerPathToHost('g', '/workspace/extra/.imap-mcp/accounts.json', [
      { hostPath: '/var/lib/sess/imap-creds', containerPath: '/workspace/extra/.imap-mcp' },
    ]);
    expect(p).toBe('/var/lib/sess/imap-creds/accounts.json');
  });

  it('choisit le mount le plus spécifique quand deux s’emboîtent', () => {
    const p = containerPathToHost('g', '/workspace/extra/dev/sub/creds.json', [
      { hostPath: '/mnt/dev', containerPath: 'dev' },
      { hostPath: '/mnt/sub', containerPath: 'dev/sub' },
    ]);
    expect(p).toBe('/mnt/sub/creds.json');
  });

  it('ne confond pas un préfixe de nom avec un préfixe de chemin', () => {
    expect(
      containerPathToHost('g', '/workspace/extra/google-mcp-old/x.json', [
        { hostPath: '/home/u/.google-mcp', containerPath: 'google-mcp' },
      ]),
    ).toBeNull();
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
    const fourth = healthLogLines([{ name: 'some-metric', status: 'info', detail: 'x' }]);
    expect(fourth).toEqual([]);
  });
});

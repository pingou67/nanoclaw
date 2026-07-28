import { describe, expect, it } from 'bun:test';

import {
  applyConfigOverrides,
  buildAgentsMd,
  interpretStreamLine,
  mapEffort,
  mcpServersToKimiConfig,
} from './kimi.js';

describe('interpretStreamLine', () => {
  it('ignores the bare tool output kimi interleaves on stdout', () => {
    // A Bash call prints its result straight to stdout, unwrapped. A strict
    // JSON parser would die on the first tool the agent runs.
    expect(interpretStreamLine('2')).toBeNull();
    expect(interpretStreamLine('Shell cwd was reset to /home/pegon/nanoclaw')).toBeNull();
    expect(interpretStreamLine('')).toBeNull();
    expect(interpretStreamLine('{not json')).toBeNull();
  });

  it('summarizes tool calls for the live-status line', () => {
    const effect = interpretStreamLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [
          { type: 'function', id: 't1', function: { name: 'Bash', arguments: '{"command":"pnpm test"}' } },
        ],
      }),
    );
    expect(effect?.progress).toEqual(['Bash(pnpm test)']);
    expect(effect?.content).toBeUndefined();
  });

  it('still reports a tool call whose arguments are not parseable', () => {
    const effect = interpretStreamLine(
      JSON.stringify({ role: 'assistant', tool_calls: [{ function: { name: 'Read', arguments: '{truncated' } }] }),
    );
    expect(effect?.progress).toHaveLength(1);
    expect(effect?.progress[0]).toContain('Read');
  });

  it('extracts assistant prose', () => {
    const effect = interpretStreamLine(JSON.stringify({ role: 'assistant', content: 'FILES=2' }));
    expect(effect?.content).toBe('FILES=2');
    expect(effect?.progress).toEqual([]);
  });

  it('extracts the session id from the trailing meta line', () => {
    const effect = interpretStreamLine(
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'session_abc' }),
    );
    expect(effect?.sessionId).toBe('session_abc');
  });

  it('treats a tool result as activity without prose', () => {
    const effect = interpretStreamLine(JSON.stringify({ role: 'tool', tool_call_id: 't1', content: '2\n' }));
    expect(effect).not.toBeNull();
    expect(effect?.content).toBeUndefined();
    expect(effect?.progress).toEqual([]);
  });
});

describe('mcpServersToKimiConfig', () => {
  it('maps stdio and remote servers, dropping the nanoclaw-only instructions key', () => {
    const config = mcpServersToKimiConfig({
      vikunja: { command: 'bun', args: ['run', 'server.ts'], env: { VIKUNJA_URL: 'https://v' } },
      ha: { type: 'http', url: 'http://ha:9583/secret', headers: { 'X-K': 'v' }, instructions: 'ignore me' },
    } as never);

    expect(config.mcpServers.vikunja).toEqual({
      command: 'bun',
      args: ['run', 'server.ts'],
      env: { VIKUNJA_URL: 'https://v' },
    });
    expect(config.mcpServers.ha).toEqual({
      url: 'http://ha:9583/secret',
      type: 'http',
      headers: { 'X-K': 'v' },
    });
  });

  it('returns an empty map when the group declares no servers', () => {
    expect(mcpServersToKimiConfig(undefined)).toEqual({ mcpServers: {} });
  });
});

describe('mapEffort', () => {
  it('folds the Claude vocabulary onto kimi support_efforts', () => {
    expect(mapEffort('low')).toBe('low');
    expect(mapEffort('medium')).toBe('high');
    expect(mapEffort('high')).toBe('high');
    expect(mapEffort('xhigh')).toBe('max');
    expect(mapEffort('max')).toBe('max');
  });

  it('returns undefined for absent or unknown efforts so the model default applies', () => {
    expect(mapEffort(undefined)).toBeUndefined();
    expect(mapEffort('turbo')).toBeUndefined();
  });
});

describe('applyConfigOverrides', () => {
  const base = [
    'default_model = "kimi-code/k3"',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'base_url = "https://api.kimi.com/coding/v1"',
    '',
    '[thinking]',
    'enabled = true',
    'effort = "high"',
    '',
    '[services.moonshot_search]',
    'base_url = "https://api.kimi.com/coding/v1/search"',
  ].join('\n');

  it('preserves the operator provider block verbatim', () => {
    const out = applyConfigOverrides(base, { model: 'kimi-code/k3-256k', effort: 'low' });
    expect(out).toContain('[providers."managed:kimi-code"]');
    expect(out).toContain('base_url = "https://api.kimi.com/coding/v1"');
    expect(out).toContain('[services.moonshot_search]');
  });

  it('replaces the model and the thinking table when the group pins them', () => {
    const out = applyConfigOverrides(base, { model: 'kimi-code/k3-256k', effort: 'max' });
    expect(out).toContain('default_model = "kimi-code/k3-256k"');
    expect(out).not.toContain('default_model = "kimi-code/k3"');
    expect(out).toContain('effort = "max"');
    expect(out).not.toContain('effort = "high"');
    // Exactly one [thinking] table — a duplicate would be a TOML parse error.
    expect(out.match(/^\[thinking\]$/gm)).toHaveLength(1);
  });

  it('leaves the operator settings untouched when the group pins nothing', () => {
    const out = applyConfigOverrides(base, {});
    expect(out).toContain('default_model = "kimi-code/k3"');
    expect(out).toContain('effort = "high"');
    expect(out.match(/^\[thinking\]$/gm)).toHaveLength(1);
  });

  it('still yields a usable config when no base file was mounted', () => {
    const out = applyConfigOverrides('', { model: 'kimi-code/k3', effort: 'high' });
    expect(out).toContain('default_model = "kimi-code/k3"');
    expect(out).toContain('[thinking]');
  });
});

describe('buildAgentsMd', () => {
  it('concatenates sources with provenance and skips empty files', () => {
    const out = buildAgentsMd([
      { path: '/app/CLAUDE.md', content: '# Base\n' },
      { path: '/workspace/agent/.claude-fragments/persona.md', content: '  \n' },
      { path: '/workspace/agent/.claude-fragments/mcp-ha.md', content: 'Home Assistant via mcp__ha__*' },
    ]);
    expect(out).toContain('<!-- /app/CLAUDE.md -->');
    expect(out).toContain('# Base');
    expect(out).toContain('Home Assistant via mcp__ha__*');
    expect(out).not.toContain('persona.md');
  });
});

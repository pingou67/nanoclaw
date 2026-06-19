import { describe, it, expect } from 'bun:test';

import { parsePluginEnv } from './opencode.js';

describe('parsePluginEnv', () => {
  it('returns [] for missing/undefined input', () => {
    expect(parsePluginEnv(undefined)).toEqual([]);
    expect(parsePluginEnv('')).toEqual([]);
  });

  it('parses a valid JSON array of strings', () => {
    expect(parsePluginEnv('["opencode-claude-memory"]')).toEqual(['opencode-claude-memory']);
    expect(parsePluginEnv('["a", "b", "c"]')).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for unparseable JSON', () => {
    expect(parsePluginEnv('not json')).toEqual([]);
    expect(parsePluginEnv('{')).toEqual([]);
  });

  it('returns [] for JSON that is not an array of strings', () => {
    expect(parsePluginEnv('{}')).toEqual([]);
    expect(parsePluginEnv('[1, 2, 3]')).toEqual([]);
    expect(parsePluginEnv('["a", 1, "b"]')).toEqual([]);
    expect(parsePluginEnv('null')).toEqual([]);
    expect(parsePluginEnv('"string"')).toEqual([]);
  });
});

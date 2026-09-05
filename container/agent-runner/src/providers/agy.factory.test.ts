import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { AgyProvider, isolateAgySettings, agyFailure } from './agy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('createProvider (agy)', () => {
  it('returns AgyProvider for agy', () => {
    expect(createProvider('agy')).toBeInstanceOf(AgyProvider);
  });
});

describe('agy scoped headless permissions', () => {
  it('isolates grants and MCP cache while preserving auth/history and restrictive host rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-policy-'));
    try {
      const real = path.join(root, 'real');
      const local = path.join(root, 'local');
      const cli = path.join(real, 'antigravity-cli');
      fs.mkdirSync(cli, { recursive: true });
      const original = JSON.stringify({ model: 'gemini', permissions: { allow: ['command(*)'], deny: ['read_file(/secrets)'], ask: ['command(*)'] } });
      fs.writeFileSync(path.join(cli, 'settings.json'), original);
      fs.writeFileSync(path.join(cli, 'auth'), 'test-fixture');
      fs.mkdirSync(path.join(cli, 'mcp'));
      const allow = ['read_file(/workspace/agent)', 'mcp(vikunja/list_projects)'];
      isolateAgySettings(real, local, JSON.stringify(allow));
      const result = JSON.parse(fs.readFileSync(path.join(local, 'antigravity-cli/settings.json'), 'utf8'));
      expect(result.permissions).toEqual({ allow, deny: ['read_file(/secrets)'], ask: ['command(*)'] });
      expect(fs.readFileSync(path.join(cli, 'settings.json'), 'utf8')).toBe(original);
      expect(fs.lstatSync(path.join(local, 'antigravity-cli/auth')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(local, 'antigravity-cli/mcp'))).toBe(false);
      expect(fs.statSync(path.join(local, 'antigravity-cli/settings.json')).mode & 0o777).toBe(0o600);
      expect(() => isolateAgySettings(real, local, '["command(*)"]')).toThrow();
      expect(() => isolateAgySettings(real, local, '["mcp(*)"]')).toThrow();
      const unsafe = path.join(root, 'unsafe');
      fs.mkdirSync(unsafe);
      fs.symlinkSync(cli, path.join(unsafe, 'antigravity-cli'));
      expect(() => isolateAgySettings(real, unsafe, '[]')).toThrow('symlinked');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('turns zero-exit permission denial into a sanitized error', () => {
    expect(agyFailure('jetski: read_file permission auto-denied https://private/secret', 0, null)).toContain('permission denied');
    expect(agyFailure('secret', 2, null)).toBe('AGY process failed (exit 2).');
    expect(agyFailure('', null, 'SIGTERM')).toContain('SIGTERM');
    expect(agyFailure('warning', 0, null)).toBeUndefined();
  });
});

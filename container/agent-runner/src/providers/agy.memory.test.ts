import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureMemoryLink } from './agy.js';

/**
 * agy persists memory to `.agents/AGENTS.md`; claude/opencode use
 * `CLAUDE.local.md`. ensureMemoryLink makes the former a symlink to the latter
 * so memory is portable across a provider switch in either direction.
 */
describe('agy ensureMemoryLink — cross-provider memory portability', () => {
  let dir: string;
  const agentsMd = () => path.join(dir, '.agents', 'AGENTS.md');
  const claudeLocal = () => path.join(dir, 'CLAUDE.local.md');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mem-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('fresh group: links AGENTS.md -> CLAUDE.local.md, preserving existing memory', () => {
    fs.writeFileSync(claudeLocal(), '# Mem\n- from claude/opencode\n');
    ensureMemoryLink(dir);

    expect(fs.lstatSync(agentsMd()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(agentsMd())).toBe('../CLAUDE.local.md');
    // A write through the link lands in the shared file (what agy will do).
    fs.appendFileSync(agentsMd(), '- from agy\n');
    const shared = fs.readFileSync(claudeLocal(), 'utf-8');
    expect(shared).toContain('from claude/opencode');
    expect(shared).toContain('from agy');
  });

  test('no CLAUDE.local.md yet: creates it empty and links', () => {
    ensureMemoryLink(dir);
    expect(fs.existsSync(claudeLocal())).toBe(true);
    expect(fs.lstatSync(agentsMd()).isSymbolicLink()).toBe(true);
  });

  test('migrates a pre-existing regular AGENTS.md into CLAUDE.local.md once', () => {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(agentsMd(), '# Prefs\n- tutoyer\n');
    fs.writeFileSync(claudeLocal(), '# Existing\n- keep me\n');

    ensureMemoryLink(dir);

    expect(fs.lstatSync(agentsMd()).isSymbolicLink()).toBe(true);
    const shared = fs.readFileSync(claudeLocal(), 'utf-8');
    expect(shared).toContain('keep me'); // shared memory preserved
    expect(shared).toContain('tutoyer'); // agy memory folded in
  });

  test('does not duplicate AGENTS.md content already present in CLAUDE.local.md', () => {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(agentsMd(), '- tutoyer\n');
    fs.writeFileSync(claudeLocal(), '# Mem\n- tutoyer\n');

    ensureMemoryLink(dir);

    const occurrences = fs.readFileSync(claudeLocal(), 'utf-8').split('tutoyer').length - 1;
    expect(occurrences).toBe(1);
  });

  test('idempotent: a second call on an already-linked dir is a no-op', () => {
    fs.writeFileSync(claudeLocal(), '- x\n');
    ensureMemoryLink(dir);
    const firstTarget = fs.readlinkSync(agentsMd());
    ensureMemoryLink(dir); // must not throw, must stay a symlink
    expect(fs.lstatSync(agentsMd()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(agentsMd())).toBe(firstTarget);
  });
});

import { describe, it, expect } from 'bun:test';

import { summarizeToolUse } from './summarize.js';

describe('summarizeToolUse', () => {
  it('renders a Bash command with truncation', () => {
    const longCmd = 'a'.repeat(200);
    expect(summarizeToolUse('Bash', { command: longCmd })).toBe(`Bash(${longCmd.slice(0, 79)}…)`);
  });

  it('renders a curl/wget web fetch as the host only (not the full command)', () => {
    expect(
      summarizeToolUse('Bash', {
        command: `curl -sL -A "Mozilla/5.0" 'https://www.cnews.fr/sport/2026-06-27/coupe-du-monde'`,
      }),
    ).toBe('Web fetch(www.cnews.fr)');
    expect(summarizeToolUse('Bash', { command: 'wget https://example.com/page' })).toBe(
      'Web fetch(example.com)',
    );
    // A non-fetch bash command still shows the command.
    expect(summarizeToolUse('Bash', { command: 'ls -la' })).toBe('Bash(ls -la)');
  });

  it('prefers the dedicated arg keys (file_path, path, command, query, pattern)', () => {
    expect(summarizeToolUse('Read', { file_path: '/etc/hostname' })).toBe('Read(/etc/hostname)');
    expect(summarizeToolUse('Read', { path: '/tmp/x' })).toBe('Read(/tmp/x)');
    expect(summarizeToolUse('Glob', { pattern: '**/*.test.ts' })).toBe('Glob(/**/*.test.ts/)');
    expect(summarizeToolUse('websearch', { query: 'foo bar' })).toBe('websearch("foo bar")');
  });

  it('falls back to a known MCP arg key when the dedicated ones are absent', () => {
    expect(summarizeToolUse('mcp__imap__imap_search', { folder: 'INBOX' })).toBe(
      'mcp__imap__imap_search(folder=INBOX)',
    );
    expect(summarizeToolUse('mcp__gmail__list', { mailbox: 'INBOX' })).toBe(
      'mcp__gmail__list(mailbox=INBOX)',
    );
    expect(summarizeToolUse('mcp__fetch__fetch', { url: 'https://example.com' })).toBe(
      'mcp__fetch__fetch(url=https://example.com)',
    );
  });

  it('uses the first arg key as a last resort', () => {
    expect(summarizeToolUse('UnknownTool', { foo: 'bar' })).toBe('UnknownTool(foo=bar)');
  });

  it('returns just the tool name when no args are provided', () => {
    expect(summarizeToolUse('LoneTool', {})).toBe('LoneTool');
  });
});

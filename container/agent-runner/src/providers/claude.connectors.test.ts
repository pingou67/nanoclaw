import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * claude.ai web connectors (Gmail, Google Calendar, Google Drive…) reach
 * headless Claude Code sessions as DEFERRED `mcp__claude_ai_*` tools (callable
 * via ToolSearch — they don't show in the init tool list). They must stay
 * hard-blocked so claude containers only use the MCP servers configured here.
 * These structural guards fail if the wiring is removed or a connector is
 * re-added to the allowlist.
 */
const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude.ts'),
  'utf-8',
);

describe('claude provider — claude.ai connectors are hard-blocked', () => {
  test('the mcp__claude_ai_* namespace is wired into disallowedTools', () => {
    expect(src).toContain("CLAUDE_AI_CONNECTOR_PREFIX = 'mcp__claude_ai_'");
    expect(src).toContain('DISALLOWED_TOOL_PATTERNS');
    expect(src).toMatch(/disallowedTools:\s*\[\.\.\.SDK_DISALLOWED_TOOLS,\s*\.\.\.DISALLOWED_TOOL_PATTERNS\]/);
  });

  test('the PreToolUse hook also blocks the connector prefix (defense-in-depth)', () => {
    expect(src).toContain('toolName.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)');
  });

  test('no mcp__claude_ai_* tool is allowlisted', () => {
    const start = src.indexOf('const TOOL_ALLOWLIST');
    const allowlist = src.slice(start, src.indexOf('];', start));
    // A real allowlist entry is a quoted string; the explanatory comment uses
    // backticks, so match only on the string-literal form.
    expect(allowlist).not.toContain("'mcp__claude_ai_");
  });
});

/**
 * Tests for runner-handled chat commands.
 *
 * Conventions:
 * - All commands are `!`-prefixed (Mattermost intercepts every `/`-command
 *   before the bot can see it, so the `/`-form was always unreachable in
 *   practice — the detectors no longer accept it).
 * - Commands are detected only on standalone chat messages (no extra text
 *   trailing, no mid-text invocation).
 * - Case-insensitive on the command itself.
 *
 * The `parseBgCancelIds` helper tests live in this file too because it
 * lives next to `isBgCancelCommand` in formatter.ts.
 */
import { describe, it, expect } from 'bun:test';

import {
  isBackgroundCommand,
  isBgCancelCommand,
  isBgListCommand,
  isClearCommand,
  isHelpCommand,
  isLiveCommand,
  isStopCommand,
  buildHelpText,
  parseBgCancelIds,
  categorizeMessage,
} from './formatter.js';
import type { MessageInRow } from './db/messages-in.js';

function makeMsg(text: string, kind: 'chat' | 'task' | 'chat-sdk' = 'chat'): MessageInRow {
  return {
    id: 'm1',
    seq: 1,
    kind,
    timestamp: '2026-06-19T18:00:00Z',
    status: 'pending',
    trigger: 1,
    on_wake: 0,
    platform_id: 'mm:dm-test',
    channel_type: 'mattermost',
    thread_id: null,
    content: JSON.stringify({ text }),
  } as MessageInRow;
}

// ============================================================================
// Slash-form removal: every command must REJECT `/`-prefixed text.
// Mattermost intercepts `/`-commands before the bot, so the `/`-form was
// never reachable in practice. Keeping it in the detector was dead code.
// ============================================================================

describe('slash-prefix removal (no `/`-form accepted)', () => {
  it('isBackgroundCommand rejects /background and /bg', () => {
    expect(isBackgroundCommand(makeMsg('/background'))).toBe(false);
    expect(isBackgroundCommand(makeMsg('/bg'))).toBe(false);
  });

  it('isLiveCommand rejects /live', () => {
    expect(isLiveCommand(makeMsg('/live'))).toBe(false);
  });

  it('isStopCommand rejects /stop', () => {
    expect(isStopCommand(makeMsg('/stop'))).toBe(false);
  });

  it('isClearCommand rejects /clear', () => {
    expect(isClearCommand(makeMsg('/clear'))).toBe(false);
    expect(isClearCommand(makeMsg('/clear some session'))).toBe(false);
  });

  it('isBgListCommand rejects /bg-list', () => {
    expect(isBgListCommand(makeMsg('/bg-list'))).toBe(false);
  });

  it('isHelpCommand rejects /help', () => {
    expect(isHelpCommand(makeMsg('/help'))).toBe(false);
  });
});

// ============================================================================
// !-form acceptance: smoke test that each command still matches its `!` form.
// Detailed per-command tests follow.
// ============================================================================

describe('!form acceptance (smoke)', () => {
  it('all commands match their `!` form', () => {
    expect(isBackgroundCommand(makeMsg('!background'))).toBe(true);
    expect(isBackgroundCommand(makeMsg('!bg'))).toBe(true);
    expect(isLiveCommand(makeMsg('!live'))).toBe(true);
    expect(isStopCommand(makeMsg('!stop'))).toBe(true);
    expect(isClearCommand(makeMsg('!clear'))).toBe(true);
    expect(isBgListCommand(makeMsg('!bg-list'))).toBe(true);
    expect(isHelpCommand(makeMsg('!help'))).toBe(true);
  });
});

// ============================================================================
// isHelpCommand + buildHelpText
// ============================================================================

describe('isHelpCommand', () => {
  it('matches !help standalone', () => {
    expect(isHelpCommand(makeMsg('!help'))).toBe(true);
  });

  it('matches !aide (French alias)', () => {
    expect(isHelpCommand(makeMsg('!aide'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isHelpCommand(makeMsg('!HELP'))).toBe(true);
    expect(isHelpCommand(makeMsg('!Help'))).toBe(true);
  });

  it('rejects when extra non-whitespace text is appended', () => {
    expect(isHelpCommand(makeMsg('!help me'))).toBe(false);
    expect(isHelpCommand(makeMsg('!help 1'))).toBe(false);
  });

  it('rejects non-chat messages', () => {
    expect(isHelpCommand(makeMsg('!help', 'task'))).toBe(false);
  });
});

describe('buildHelpText', () => {
  it('mentions every supported `!`-command', () => {
    const text = buildHelpText();
    // Sanity: the help should list all the commands the runner supports.
    // If a new command is added without updating the help text, this catches it.
    for (const cmd of [
      '!help', '!background', '!bg', '!stop', '!live', '!clear',
      '!bg-list', '!bg-cancel',
    ]) {
      expect(text).toContain(cmd);
    }
  });

  it('explains the `!`-prefix rationale (Mattermost intercepts `/`)', () => {
    expect(buildHelpText()).toMatch(/Mattermost.*intercepte/i);
  });

  it('is a non-empty single string (Mattermost expects one text blob)', () => {
    const text = buildHelpText();
    expect(text.length).toBeGreaterThan(200);
    expect(text).not.toContain('undefined');
  });
});

// ============================================================================
// isBgCancelCommand + parseBgCancelIds (per-bg control, kept here for the
// related `!bg-list` / `!bg-cancel` machinery).
// ============================================================================

describe('isBgCancelCommand', () => {
  it('matches !bg-cancel standalone (cancel all)', () => {
    expect(isBgCancelCommand(makeMsg('!bg-cancel'))).toBe(true);
  });

  it('matches the common aliases', () => {
    expect(isBgCancelCommand(makeMsg('!bgcancel'))).toBe(true);
    expect(isBgCancelCommand(makeMsg('!bg cancel'))).toBe(true);
  });

  it('matches !bg-cancel N for a single bg', () => {
    expect(isBgCancelCommand(makeMsg('!bg-cancel 1'))).toBe(true);
    expect(isBgCancelCommand(makeMsg('!bg-cancel 42'))).toBe(true);
  });

  it('matches !bg-cancel N M for multiple bgs', () => {
    expect(isBgCancelCommand(makeMsg('!bg-cancel 1 2 3'))).toBe(true);
    expect(isBgCancelCommand(makeMsg('!bg-cancel 1 2'))).toBe(true);
  });

  it('rejects random text', () => {
    expect(isBgCancelCommand(makeMsg('hello'))).toBe(false);
    expect(isBgCancelCommand(makeMsg('!bg-cancel now'))).toBe(false);
    expect(isBgCancelCommand(makeMsg('!bg-cancel please'))).toBe(false);
  });

  it('rejects non-chat messages', () => {
    expect(isBgCancelCommand(makeMsg('!bg-cancel', 'task'))).toBe(false);
  });
});

describe('parseBgCancelIds', () => {
  it('returns empty array for standalone !bg-cancel (caller interprets as "all")', () => {
    expect(parseBgCancelIds(makeMsg('!bg-cancel'))).toEqual([]);
  });

  it('extracts single id', () => {
    expect(parseBgCancelIds(makeMsg('!bg-cancel 1'))).toEqual(['bg-1']);
  });

  it('extracts multiple ids', () => {
    expect(parseBgCancelIds(makeMsg('!bg-cancel 1 2 3'))).toEqual(['bg-1', 'bg-2', 'bg-3']);
  });

  it('is case-insensitive on the command prefix', () => {
    expect(parseBgCancelIds(makeMsg('!BG-CANCEL 1'))).toEqual(['bg-1']);
  });

  it('returns [] for non-matching messages', () => {
    expect(parseBgCancelIds(makeMsg('hello'))).toEqual([]);
    expect(parseBgCancelIds(makeMsg('!bg-list'))).toEqual([]);
  });
});

// ============================================================================
// isBgListCommand (per-bg control)
// ============================================================================

describe('isBgListCommand', () => {
  it('matches !bg-list standalone', () => {
    expect(isBgListCommand(makeMsg('!bg-list'))).toBe(true);
  });

  it('matches the common aliases', () => {
    expect(isBgListCommand(makeMsg('!bglist'))).toBe(true);
    expect(isBgListCommand(makeMsg('!bg list'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isBgListCommand(makeMsg('!BG-LIST'))).toBe(true);
    expect(isBgListCommand(makeMsg('!Bg-List'))).toBe(true);
  });

  it('rejects when extra non-whitespace text is appended', () => {
    expect(isBgListCommand(makeMsg('!bg-list please'))).toBe(false);
    expect(isBgListCommand(makeMsg('!bg-list 1'))).toBe(false);
  });

  it('accepts trailing whitespace (trimmed by the detector)', () => {
    expect(isBgListCommand(makeMsg('!bg-list\n'))).toBe(true);
    expect(isBgListCommand(makeMsg('  !bg-list  '))).toBe(true);
  });

  it('rejects non-chat messages', () => {
    expect(isBgListCommand(makeMsg('!bg-list', 'task'))).toBe(false);
  });
});

// ============================================================================
// categorizeMessage — the upstream router that decides how the follow-up
// poller should treat a follow-up message (abort? pass through? drop?).
// The `/` and `!` forms must produce the same category so mid-stream
// `!clear` / `!stop` cause the active query to abort, just like `/`-form
// commands do in the integration test.
// ============================================================================

describe('categorizeMessage — `/` and `!` forms route identically', () => {
  it('categorizes /clear as admin', () => {
    const r = categorizeMessage(makeMsg('/clear'));
    expect(r.category).toBe('admin');
    expect(r.command).toBe('/clear');
  });

  it('categorizes !clear as admin (mid-stream abort works for ! form)', () => {
    const r = categorizeMessage(makeMsg('!clear'));
    expect(r.category).toBe('admin');
    expect(r.command).toBe('!clear');
  });

  it('categorizes /stop as passthrough (the runner detects it via isStopCommand, not via admin flow)', () => {
    // /stop is NOT in ADMIN_COMMANDS — it's handled by the runner's
    // isStopCommand detector in the follow-up poller + outer loop. The
    // categorizeMessage layer passes it through. Same for !stop.
    expect(categorizeMessage(makeMsg('/stop')).category).toBe('passthrough');
    expect(categorizeMessage(makeMsg('!stop')).category).toBe('passthrough');
  });

  it('categorizes /compact as admin', () => {
    expect(categorizeMessage(makeMsg('/compact')).category).toBe('admin');
  });

  it('categorizes !compact as admin', () => {
    expect(categorizeMessage(makeMsg('!compact')).category).toBe('admin');
  });

  it('categorizes /login as filtered (Mattermost-native)', () => {
    expect(categorizeMessage(makeMsg('/login')).category).toBe('filtered');
  });

  it('does NOT have a /help or !help filter (help is a runner command now)', () => {
    // /help and !help are NO LONGER filtered — they're runner commands
    // that respond with the help text. They reach the passthrough/admin
    // path, where the runner's isHelpCommand() catches them first.
    expect(categorizeMessage(makeMsg('/help')).category).not.toBe('filtered');
    expect(categorizeMessage(makeMsg('!help')).category).not.toBe('filtered');
  });

  it('categorizes /upload-trace as admin (preserves !-form behavior)', () => {
    expect(categorizeMessage(makeMsg('/upload-trace')).category).toBe('admin');
    expect(categorizeMessage(makeMsg('!upload-trace')).category).toBe('admin');
  });

  it('returns none for non-command messages', () => {
    expect(categorizeMessage(makeMsg('hello')).category).toBe('none');
    expect(categorizeMessage(makeMsg('reply to the mail')).category).toBe('none');
  });

  it('returns none for messages without `/` or `!` prefix', () => {
    expect(categorizeMessage(makeMsg('!bg-list')).category).not.toBe('none');
    expect(categorizeMessage(makeMsg('something else')).category).toBe('none');
  });
});

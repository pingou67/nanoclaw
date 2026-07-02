import { describe, it, expect } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk';

import { toolPartToProgress } from './opencode.js';
import type { ProviderEvent } from './types.js';

function makeToolPart(overrides: Partial<ToolPart> & { state: ToolPart['state'] }): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'sess-1',
    messageID: 'msg-1',
    type: 'tool',
    callID: overrides.callID ?? 'call-1',
    tool: overrides.tool ?? 'Bash',
    state: overrides.state,
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  } as ToolPart;
}

describe('toolPartToProgress', () => {
  it('emits a progress event for a pending tool part', () => {
    const seen = new Set<string>();
    const part = makeToolPart({
      callID: 'call-1',
      tool: 'Bash',
      state: { status: 'pending', input: { command: 'pnpm test' }, raw: '' },
    });
    const ev = toolPartToProgress(part, seen);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('progress');
    expect((ev as { message: string }).message).toBe('Bash(pnpm test)');
    expect(seen.has('call-1')).toBe(true);
  });

  it('emits a progress event for a running tool part (first sighting)', () => {
    const seen = new Set<string>();
    const part = makeToolPart({
      callID: 'call-2',
      tool: 'mcp__brave-search__brave_search',
      state: {
        status: 'running',
        input: { query: 'Agathe Pegon gymnaste' },
        time: { start: 0 },
      },
    });
    const ev = toolPartToProgress(part, seen);
    expect(ev).not.toBeNull();
    expect((ev as { message: string }).message).toBe(
      'mcp__brave-search__brave_search("Agathe Pegon gymnaste")',
    );
  });

  it('dedupes: the same callID in running state after pending yields nothing', () => {
    const seen = new Set<string>();
    const pending = makeToolPart({
      callID: 'call-3',
      tool: 'Bash',
      state: { status: 'pending', input: { command: 'ls' }, raw: '' },
    });
    const running = {
      ...pending,
      state: { status: 'running' as const, input: { command: 'ls' }, time: { start: 1 } },
    };
    expect(toolPartToProgress(pending, seen)).not.toBeNull();
    expect(toolPartToProgress(running as ToolPart, seen)).toBeNull();
  });

  it('returns null for a completed tool part (terminal state)', () => {
    const seen = new Set<string>();
    const part = makeToolPart({
      callID: 'call-4',
      tool: 'Bash',
      state: {
        status: 'completed',
        input: { command: 'echo ok' },
        output: 'ok',
        title: 'echo ok',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    });
    expect(toolPartToProgress(part, seen)).toBeNull();
    expect(seen.has('call-4')).toBe(false);
  });

  it('returns null for an errored tool part (terminal state)', () => {
    const seen = new Set<string>();
    const part = makeToolPart({
      callID: 'call-5',
      tool: 'Bash',
      state: {
        status: 'error',
        input: { command: 'false' },
        error: 'exit 1',
        time: { start: 0, end: 1 },
      },
    });
    expect(toolPartToProgress(part, seen)).toBeNull();
  });

  it('emits one progress event per distinct callID across a multi-tool turn', () => {
    const seen = new Set<string>();
    const events: ProviderEvent[] = [];
    for (const callID of ['a', 'b', 'a', 'c', 'b']) {
      const ev = toolPartToProgress(
        makeToolPart({
          callID,
          tool: 'Bash',
          state: { status: 'running', input: { command: `echo ${callID}` }, time: { start: 0 } },
        }),
        seen,
      );
      if (ev) events.push(ev);
    }
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e as { message: string }).message)).toEqual([
      'Bash(echo a)',
      'Bash(echo b)',
      'Bash(echo c)',
    ]);
  });
});

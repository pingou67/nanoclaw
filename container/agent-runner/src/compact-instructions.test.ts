import { describe, expect, it } from 'bun:test';

import { buildCompactInstructions } from './compact-instructions.js';

describe('compaction delivery reminder', () => {
  it('preserves final-output addressing in chat sessions', () => {
    const instructions = buildCompactInstructions(['family'], null);

    // Fork §31 : le hook PreCompact ne tourne que côté Claude (structured
    // delivery) — la branche chat rappelle le contrat structured, jamais
    // l'enveloppe <message to>.
    expect(instructions).toContain('Do NOT wrap responses in <message> tags');
    expect(instructions).toContain('send_message');
    expect(instructions).toContain('`family`');
  });

  it('preserves explicit-tool delivery in task sessions without teaching final-output blocks', () => {
    const instructions = buildCompactInstructions(['family'], 'daily-digest-a1b2');

    expect(instructions).toContain('send_message');
    expect(instructions).toContain('explicit to destination');
    expect(instructions).toContain('tasks/daily-digest-a1b2.md');
    expect(instructions).not.toContain('<message to="name">');
  });
});

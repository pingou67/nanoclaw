import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkill, hostExec, hostExecStream, promptValidator, type RunSkillOptions } from './skill-driver.js';
import { fullyApplied, type Prompter, type StepReporter } from '../../scripts/skill-apply.js';

// A small SKILL.md exercising the three things the driver wires: an operator
// block (relayed via tell), a secret prompt (asked via ask), and a wire run
// (executed via exec) consuming the captured input.
const SKILL = `# driver demo

## Set up
Tell the user:
\`\`\`nc:operator
Go create the app and copy the token.
\`\`\`
\`\`\`nc:prompt token secret
Paste the token.
\`\`\`

## Wire
\`\`\`nc:run effect:wire
ncl wire --token {{token}}
\`\`\`
`;

function scratch(): { root: string; skill: string } {
  const root = mkdtempSync(join(tmpdir(), 'driver-'));
  const skill = mkdtempSync(join(tmpdir(), 'driver-skill-'));
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(skill, 'SKILL.md'), SKILL);
  return { root, skill };
}

describe('thin skill driver', () => {
  it('asks prompts, relays operator blocks, and execs wiring — with an injected prompter', async () => {
    const { root, skill } = scratch();
    const asked: string[] = [];
    const told: string[] = [];
    const ran: string[] = [];
    const prompter: Prompter = {
      async ask(name) {
        asked.push(name);
        return 'T0KEN';
      },
      tell: (t) => void told.push(t),
    };
    const opts: RunSkillOptions = { projectRoot: root, prompter, exec: (c) => void ran.push(c) };
    const res = await runSkill(skill, opts);

    expect(asked).toEqual(['token']); // the prompt was driven through ask
    expect(told).toEqual(['Go create the app and copy the token.']); // operator relayed through tell
    expect(ran).toContain('ncl wire --token T0KEN'); // wiring executed with the answer substituted in
    expect(res.operatorMessages).toEqual(['Go create the app and copy the token.']);
  });

  it('runs fully from inputs — no prompter touched', async () => {
    const { root, skill } = scratch();
    const ran: string[] = [];
    const res = await runSkill(skill, { projectRoot: root, inputs: { token: 'FROM-INPUTS' }, exec: (c) => void ran.push(c) });
    expect(fullyApplied(res)).toBe(true);
    expect(ran).toContain('ncl wire --token FROM-INPUTS');
  });

  it('threads a step reporter through to the engine — the wire run spins under its heading', async () => {
    const { root, skill } = scratch();
    const starts: Array<{ kind: string; label: string | null }> = [];
    const reporter: StepReporter = {
      stepStart: (e) => void starts.push({ kind: e.kind, label: e.label }),
      stepEnd: () => {},
    };
    await runSkill(skill, { projectRoot: root, inputs: { token: 'T' }, exec: () => {}, reporter });
    // the demo SKILL's only mutating step is `nc:run effect:wire` under `## Wire`
    expect(starts).toEqual([{ kind: 'run', label: 'Wire' }]);
  });

  it('hostExec puts the project bin/ on PATH so a bare command resolves to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-bin-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/greet'), '#!/usr/bin/env bash\necho hi-from-bin\n');
    chmodSync(join(root, 'bin/greet'), 0o755);
    const out = hostExec(root)('greet'); // bare name, not ./bin/greet
    expect(String(out).trim()).toBe('hi-from-bin');
  });

  it('hostExec returns stdout so a capture run can bind it', () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-cap-'));
    expect(String(hostExec(root)('echo D0CHANNEL')).trim()).toBe('D0CHANNEL');
  });

  it('hostExecStream runs a step and captures the terminal status block fields (for effect:step)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-step-'));
    const out = await hostExecStream(root)(
      'echo show-this-to-the-operator; echo "=== NANOCLAW SETUP: PAIR ==="; echo "STATUS: success"; echo "PLATFORM_ID: telegram:42"; echo "=== END ==="',
    );
    expect(out.ok).toBe(true);
    expect(out.fields.PLATFORM_ID).toBe('telegram:42');
  });

  function reuseScratch(): { root: string; skill: string } {
    const root = mkdtempSync(join(tmpdir(), 'reuse-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), 'SLACK_BOT_TOKEN=xoxb-existing-token\n');
    // a skill whose env-set maps bot_token → SLACK_BOT_TOKEN (the reuse linkage)
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# reuse demo\n\n```nc:prompt bot_token secret\nPaste the token.\n```\n```nc:env-set\nSLACK_BOT_TOKEN={{bot_token}}\n```\n```nc:run effect:wire\nuse {{bot_token}}\n```\n',
    );
    return { root, skill };
  }

  it('reuse:true offers an existing .env credential and skips the prompt when accepted', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    const prompter: Prompter = {
      async ask(n) {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      async confirm() {
        return true; // yes, reuse the existing value
      },
    };
    await runSkill(skill, { projectRoot: root, prompter, reuse: true, exec: (c) => void cmds.push(c) });
    expect(asked).not.toContain('bot_token'); // reused from .env → never prompted
    expect(cmds).toContain('use xoxb-existing-token'); // the reused value flowed downstream
  });

  it('reuse: declining keeps the prompt', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    const prompter: Prompter = {
      async ask(n) {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      async confirm() {
        return false; // no, ask me
      },
    };
    await runSkill(skill, { projectRoot: root, prompter, reuse: true, exec: (c) => void cmds.push(c) });
    expect(asked).toContain('bot_token'); // declined → prompted
    expect(cmds).toContain('use NEWLY-PASTED');
  });

  // A cred a HELPER SCRIPT owns (written by effect:external, not nc:env-set) has no
  // env-set→ENV_KEY linkage to infer. An explicit `nc:prompt … reuse:<ENV_KEY>`
  // restores the masked reuse offer — the imessage Photon case.
  function helperReuseScratch(): { root: string; skill: string } {
    const root = mkdtempSync(join(tmpdir(), 'reuse-helper-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-helper-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    // present in .env, but NOT written by any nc:env-set in the skill below
    writeFileSync(join(root, '.env'), 'IMESSAGE_SERVER_URL=https://photon.example.com\n');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# helper reuse demo\n\n```nc:prompt server_url validate:^https?:// reuse:IMESSAGE_SERVER_URL\nYour Photon server URL.\n```\n```nc:run effect:external\nbash configure.sh "{{server_url}}"\n```\n',
    );
    return { root, skill };
  }

  it('reuse: offers an existing .env value for a HELPER-owned cred (no env-set linkage)', async () => {
    const { root, skill } = helperReuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    const confirmed: string[] = [];
    const prompter: Prompter = {
      async ask(n) {
        asked.push(n);
        return 'https://typed.example';
      },
      async confirm(msg) {
        confirmed.push(msg);
        return true; // yes, reuse the existing helper-owned value
      },
    };
    await runSkill(skill, { projectRoot: root, prompter, reuse: true, exec: (c) => void cmds.push(c) });
    expect(confirmed.some((m) => /IMESSAGE_SERVER_URL/.test(m))).toBe(true); // the reuse: link surfaced the offer
    expect(asked).not.toContain('server_url'); // accepted → never re-prompted
    expect(cmds).toContain('bash configure.sh "https://photon.example.com"'); // reused value flowed downstream
  });

  it('promptValidator honors flags:i (case-insensitive) and min (rejects short); error overrides the message', () => {
    const ci = promptValidator('^https://', { flags: 'i' });
    expect(ci).toBeDefined();
    expect(ci!('HTTPS://example.com')).toBeUndefined(); // case-insensitive match passes
    expect(ci!('ftp://example.com')).toBeTruthy(); // non-match rejected
    const min = promptValidator(undefined, { min: 20 });
    expect(min!('short')).toBeTruthy(); // below the minimum length → rejected
    expect(min!('x'.repeat(20))).toBeUndefined(); // at the minimum → passes
    expect(promptValidator('^x', { error: 'Bad token format' })!('y')).toBe('Bad token format'); // custom message
    expect(promptValidator(undefined, undefined)).toBeUndefined(); // no regex + no min ⇒ no validator
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runChannelSkill } from './run-channel-skill.js';
import { BACK_TO_CHANNEL_SELECTION, backGate } from '../lib/back-nav.js';

// Drive the first-prompt back gate (back-nav's brightSelect) from a queue
// instead of opening a real TTY select. Hoisted so the vi.mock factory — which
// runs before imports — can close over it. The existing Option-A tests never
// opt into offerBack (and pass `role` so askOperatorRole's brightSelect isn't
// reached either), so the mock is inert for them.
const bs = vi.hoisted(() => ({ answers: [] as string[] }));
vi.mock('../lib/bright-select.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/bright-select.js')>();
  return { ...actual, brightSelect: vi.fn(async () => bs.answers.shift() ?? 'continue') };
});

// Drives the real add-slack skill through the adapter with every side effect
// injected (no real ncl/git/clack/init-first-agent): confirms it runs the skill
// (install + creds + resolve), reads the resolved owner_handle + platform_id from
// the result, and hands them to the shared wire with a composed user-id.
describe('runChannelSkill adapter (Option A)', () => {
  it('resolves via the skill, then wires through init-first-agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.includes('auth.test')) return '@bot in Acme\n'; // identity capture
      // the resolve run: conversations.open piped through jq → "slack:<channel>"
      if (c.includes('conversations.open')) return 'slack:D0SLACK\n';
    };
    const wired: Array<Record<string, unknown>> = [];

    await runChannelSkill('slack', 'Bob Smith', {
      projectRoot: root,
      exec,
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      // the secrets + handle a human would supply; the skill resolves platform_id.
      // Values are valid-shaped for the prompts' validate: regexes — validate-at-bind
      // now enforces them on `inputs` too (they used to bypass validation).
      inputs: { connection: 'webhook', bot_token: 'xoxb-x', signing_secret: '0123456789abcdef', owner_handle: 'U12345678' },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    // the channel-specific resolve ran
    expect(cmds.some((c) => c.includes('auth.test'))).toBe(true);
    expect(cmds.some((c) => c.includes('conversations.open'))).toBe(true);
    // ...and the shared wire got the composed user-id + resolved platform_id
    expect(wired).toHaveLength(1);
    expect(wired[0]).toMatchObject({
      channel: 'slack',
      userId: 'slack:U12345678', // channel + owner_handle
      platformId: 'slack:D0SLACK', // captured from conversations.open
      displayName: 'Bob Smith',
      agentName: 'Nano',
      role: 'owner',
    });
    // the adapter no longer emits any ncl wiring itself — that's init-first-agent's job
    expect(cmds.some((c) => c.startsWith('ncl '))).toBe(false);
  });

  // Teams' platform_id only exists after the first inbound, so its SKILL.md
  // installs + hands off and runChannelSkill is called with deferWire — it must
  // run the skill but never reach the shared wire. This is the driver-policy
  // parity fixture: it runs the DEFAULT onEvent handler (never an injected
  // onEvent, which would replace the policy — §5.0) and injects the
  // confirm/openUrl seams to prove both natural barriers fire and the portal
  // URL offer survives from the operator prose alone.
  it('deferWire (Teams): default policy fires the gate barriers + portal URL offer, never reaches the shared wire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-teams-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const log: string[] = [];
    const opened: string[] = [];
    const wired: unknown[] = [];

    await runChannelSkill('teams', 'Acme Corp', {
      projectRoot: root,
      exec: (c) => void log.push(`exec:${c}`),
      resolveRemote: () => 'origin',
      reuse: false,
      deferWire: true,
      // The injectable interaction seams — the default handler consults them for
      // the URL offer and the natural-barrier confirms, so no real clack confirm
      // (which would hang in CI) and no real browser open is reached.
      confirm: async (m) => {
        log.push(`confirm:${m}`);
        return true;
      },
      openUrl: async (u) => void opened.push(u),
      // a MultiTenant app, so the SingleTenant-guarded app_tenant_id prompt is skipped
      inputs: {
        public_url: 'https://acme.example',
        app_id: '12345678-1234-1234-1234-123456789abc',
        app_type: 'MultiTenant',
        app_password: 'a-much-longer-app-password', // 20+ chars — valid for the declared shape
      },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    // install + manifest ran…
    expect(log.some((c) => c.includes('teams-manifest-build'))).toBe(true);
    // …the Azure portal offer came from the operator BODY text (policy §5.2)…
    expect(opened.some((u) => /portal\.azure\.com/.test(u))).toBe(true);
    // …a natural-barrier confirm (not a URL offer) fired BEFORE the manifest
    // build (the manifest-before-the-app hazard fix, now derived from document
    // structure instead of an authored gate attr)…
    const firstGate = log.findIndex((c) => c.startsWith('confirm:') && !c.startsWith('confirm:Open '));
    const manifestAt = log.findIndex((c) => c.includes('teams-manifest-build'));
    expect(firstGate).toBeGreaterThanOrEqual(0);
    expect(firstGate).toBeLessThan(manifestAt);
    // …but the shared wire was never reached (no owner_handle/platform_id needed)
    expect(wired).toHaveLength(0);
  });

  // The engine reads `.claude/skills/add-<channel>/SKILL.md` relative to cwd (the
  // repo root in tests — same as the real add-slack the test above drives), so a
  // bounce-fixture skill is created there and torn down afterward.
  const failChannel = 'failtest';
  const failSkillDir = join(process.cwd(), '.claude/skills', `add-${failChannel}`);
  afterEach(() => rmSync(failSkillDir, { recursive: true, force: true }));

  // When the skill doesn't fully apply (a directive bounced to an agent), the
  // generic "couldn't finish" message is replaced by the bounced step's OWN
  // prose: the section heading becomes fail()'s headline and the surrounding
  // prose becomes the dimmed hint (which fail() also forwards to the Claude
  // handoff). Asserted via an injected fail spy (the real fail() process.exits).
  it('threads the bounced step prose into fail() when the skill does not fully apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-fail-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), '');
    // A skill whose only directive bounces — the engine has no handler for
    // nc:hand-wire, so it degrades to an agent and the run is not fully applied.
    mkdirSync(failSkillDir, { recursive: true });
    writeFileSync(
      join(failSkillDir, 'SKILL.md'),
      [
        `# add ${failChannel}`,
        '',
        '## Register the webhook by hand',
        'Open the Faily dashboard and paste the webhook URL into the bot settings.',
        '```nc:hand-wire',
        'register webhook',
        '```',
        '',
      ].join('\n'),
    );

    const failCalls: Array<{ step: string; msg: string; hint?: string }> = [];
    const fakeFail = (step: string, msg: string, hint?: string): Promise<never> => {
      failCalls.push({ step, msg, hint });
      // The real fail() process.exits and never returns; emulate that by aborting
      // the flow so control doesn't fall through to the resolve/wire steps.
      return Promise.reject(new Error('__failed__'));
    };

    await expect(
      runChannelSkill(failChannel, 'Bob', {
        projectRoot: root,
        exec: () => {},
        resolveRemote: () => 'origin',
        agentName: 'Nano',
        role: 'owner',
        reuse: false,
        inputs: {},
        fail: fakeFail,
        wire: () => true,
      }),
    ).rejects.toThrow('__failed__');

    expect(failCalls).toHaveLength(1);
    expect(failCalls[0].step).toBe(`${failChannel}-install`);
    expect(failCalls[0].msg).toBe('Register the webhook by hand'); // heading → headline
    expect(failCalls[0].hint).toContain('Open the Faily dashboard'); // prose → hint
    expect(failCalls[0].hint).not.toBe('See logs/setup-steps/ for details, then retry setup.'); // not the generic
  });
});

// M5 backGate — the first-prompt "← Back to channel selection" gate. It's a
// brightSelect (mocked above) wrapped in ensureAnswer; on back it returns the
// existing BACK_TO_CHANNEL_SELECTION sentinel that setup/auto.ts already catches.
describe('backGate (first-prompt back-to-channel-selection)', () => {
  it('returns the sentinel on back and continue otherwise', async () => {
    bs.answers = ['back'];
    expect(await backGate('Slack DMs')).toBe(BACK_TO_CHANNEL_SELECTION);

    bs.answers = ['continue'];
    expect(await backGate('Slack DMs')).toBe('continue');
  });

  // offerBack runs the gate at the very top — before resolveAgentName/role, the
  // skill run, and the wire. Picking back returns the sentinel without touching
  // any side effect (no exec, no wire).
  it('runChannelSkill with offerBack returns the sentinel before running the skill', async () => {
    bs.answers = ['back'];
    const cmds: string[] = [];
    const wired: unknown[] = [];

    const result = await runChannelSkill('slack', 'Bob Smith', {
      offerBack: true,
      exec: (c) => void cmds.push(c),
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      inputs: { connection: 'webhook', bot_token: 'xoxb-x', signing_secret: '0123456789abcdef', owner_handle: 'U12345678' },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    expect(result).toBe(BACK_TO_CHANNEL_SELECTION);
    expect(cmds).toHaveLength(0); // the skill never ran
    expect(wired).toHaveLength(0); // the wire was never reached
  });
});

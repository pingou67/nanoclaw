import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySkill, removeSkill, planSkill, fullyApplied, firstFailureHint, stepLabel, type Prompter, type PromptOpts, type StepReporter } from './skill-apply.js';
import { parseDirectives, validate } from './skill-directives.js';

// A synthetic skill exercising the fs handlers for real (no network), plus one
// directive the engine can't handle — to prove it bounces to an agent, not abort.
const SKILL = `# demo skill

## Copy the file
\`\`\`nc:copy
resources/sample.ts -> src/sample.ts
\`\`\`

## Register it
\`\`\`nc:append to:src/barrel.ts
import './sample.js';
\`\`\`

## Capture and store a secret
\`\`\`nc:prompt token secret
Paste the demo token.
\`\`\`
\`\`\`nc:env-set
DEMO_TOKEN={{token}}
\`\`\`

## A step the engine can't do deterministically
Hand-edit the scheduler to register the demo hook.
\`\`\`nc:patch-scheduler
register demo
\`\`\`
`;

let root: string;
let skillDir: string;
const headless = (vals: Record<string, string>): Prompter => ({ async ask(name) { return vals[name]; } });
const recordingExec = () => {
  const cmds: string[] = [];
  return { cmds, exec: (c: string) => void cmds.push(c) };
};

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'nc-skill-'));
  root = mkdtempSync(join(tmpdir(), 'nc-proj-'));
  mkdirSync(join(skillDir, 'resources'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL);
  writeFileSync(join(skillDir, 'resources/sample.ts'), 'export const sample = true;\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/barrel.ts'), '// channel barrel\n');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
});

describe('apply engine lifecycle', () => {
  it('applies fs directives, captures the secret, and bounces the unknown step to an agent', async () => {
    const { exec } = recordingExec();
    const res = await applySkill(skillDir, root, { prompter: headless({ token: 'sekret-123' }), exec });

    // mutations happened
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/barrel.ts'), 'utf8')).toContain("import './sample.js';");
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('DEMO_TOKEN=sekret-123');

    // the unknown directive went to an agent — with prose — not the human, not an abort
    expect(res.agentTasks).toHaveLength(1);
    expect(res.agentTasks[0].kind).toBe('patch-scheduler');
    expect(res.agentTasks[0].prose).toContain('Hand-edit the scheduler');
    expect(res.deferred).toEqual([]);
    expect(res.journal.length).toBeGreaterThanOrEqual(3); // wrote + appended + set-env
  });

  it('is idempotent — a second apply changes nothing', async () => {
    const p = headless({ token: 'sekret-123' });
    await applySkill(skillDir, root, { prompter: p, exec: () => {} });
    const second = await applySkill(skillDir, root, { prompter: p, exec: () => {} });
    expect(second.applied).toEqual([]); // everything already applied
    expect(second.journal).toEqual([]); // nothing mutated
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('removes cleanly from the journal — no hand-written REMOVE.md', async () => {
    const res = await applySkill(skillDir, root, { prompter: headless({ token: 'sekret-123' }), exec: () => {} });
    await removeSkill(root, res.journal);
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(false);
    expect(readFileSync(join(root, 'src/barrel.ts'), 'utf8')).not.toContain("import './sample.js';");
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DEMO_TOKEN');
  });

  it('defers a prompt (and its consumer) when the prompter has no value — headless rebuild', async () => {
    const res = await applySkill(skillDir, root, { prompter: headless({}), exec: () => {} });
    expect(res.deferred).toContain('token'); // prompt deferred
    expect(res.deferred.some((d) => /unresolved \{\{token\}\}/.test(d))).toBe(true); // env-set blocked on it
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DEMO_TOKEN');
  });

  it('plan marks the unknown step ↳agent and the prompt ? needs-input before any write', () => {
    const { steps, agentSteps, needsInput } = planSkill(skillDir, root);
    expect(agentSteps).toBe(1);
    expect(needsInput).toContain('token');
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(false); // planning mutated nothing
  });
});

// json-merge: push a body object into an array-of-objects JSON file, keyed.
const JSON_MERGE_SKILL = `# json-merge demo

## Register the CLI tool
\`\`\`nc:json-merge into:container/cli-tools.json key:name
{ "name": "@openai/codex", "version": "0.138.0" }
\`\`\`
`;

describe('json-merge directive', () => {
  let jroot: string;
  let jskill: string;
  beforeEach(() => {
    jskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    jroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(jskill, 'SKILL.md'), JSON_MERGE_SKILL);
    mkdirSync(join(jroot, 'container'), { recursive: true });
    writeFileSync(join(jroot, 'container/cli-tools.json'), '[\n  { "name": "vercel", "version": "52.2.1" }\n]\n');
  });

  it('pushes the object, preserving 2-space indent + trailing newline', async () => {
    const res = await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    const out = readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8');
    expect(out.endsWith('\n')).toBe(true);
    const arr = JSON.parse(out);
    expect(arr).toEqual([
      { name: 'vercel', version: '52.2.1' },
      { name: '@openai/codex', version: '0.138.0' },
    ]);
    expect(out).toBe(JSON.stringify(arr, null, 2) + '\n'); // 2-space indent
    expect(res.journal.some((e) => e.op === 'json-merge')).toBe(true);
  });

  it('is idempotent — re-applying does not duplicate the element', async () => {
    await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    const second = await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(1);
    const arr = JSON.parse(readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8'));
    expect(arr.filter((e: { name: string }) => e.name === '@openai/codex')).toHaveLength(1);
  });

  it('removeSkill drops the element whose key matches', async () => {
    const res = await applySkill(jskill, jroot, { prompter: headless({}), exec: () => {} });
    await removeSkill(jroot, res.journal);
    const arr = JSON.parse(readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8'));
    expect(arr).toEqual([{ name: 'vercel', version: '52.2.1' }]);
  });

  it('plan marks it →apply when absent, ✓skip when present', () => {
    const before = planSkill(jskill, jroot);
    expect(before.steps[0].status).toBe('apply');
    // simulate already-merged
    writeFileSync(
      join(jroot, 'container/cli-tools.json'),
      JSON.stringify([{ name: '@openai/codex', version: '0.138.0' }], null, 2) + '\n',
    );
    const after = planSkill(jskill, jroot);
    expect(after.steps[0].status).toBe('skip');
  });
});

// append at:<marker>: insert before a dormant region's closing line.
const MARKER_FILE = ['const STEPS = {', "  auth: () => import('./auth.js'),", '  // >>> nanoclaw:setup-steps', '  // <<< nanoclaw:setup-steps', '};', ''].join('\n');
const APPEND_AT_SKILL = `# append-at demo

## Register a setup step
\`\`\`nc:append to:setup/index.ts at:nanoclaw:setup-steps
codex: () => import('./codex.js'),
\`\`\`
`;
const APPEND_EOF_SKILL = `# append-eof demo

## Register at EOF
\`\`\`nc:append to:setup/index.ts
// trailing line
\`\`\`
`;

describe('append at:<marker>', () => {
  let aroot: string;
  let askill: string;
  beforeEach(() => {
    askill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    aroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    mkdirSync(join(aroot, 'setup'), { recursive: true });
    writeFileSync(join(aroot, 'setup/index.ts'), MARKER_FILE);
  });

  it('inserts before the `<<< marker` line, matching its indentation', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    const out = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n');
    const closeIdx = out.findIndex((l) => l.includes('<<< nanoclaw:setup-steps'));
    expect(out[closeIdx - 1]).toBe("  codex: () => import('./codex.js'),"); // inserted just above, 2-space indent
    expect(out[closeIdx - 2]).toContain('>>> nanoclaw:setup-steps'); // open marker untouched
  });

  it('is idempotent (whole-file line check) regardless of position', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    const second = await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    expect(second.applied).toEqual([]);
    const count = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n').filter((l) => l.trim() === "codex: () => import('./codex.js'),").length;
    expect(count).toBe(1);
  });

  it('removeSkill deletes the inserted line (position-agnostic, by trimmed line)', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    const res = await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    await removeSkill(aroot, res.journal);
    expect(readFileSync(join(aroot, 'setup/index.ts'), 'utf8')).not.toContain("codex: () => import('./codex.js'),");
  });

  it('without at: still appends at EOF (unchanged behavior)', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_EOF_SKILL);
    await applySkill(askill, aroot, { prompter: headless({}), exec: () => {} });
    const lines = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n').filter(Boolean);
    expect(lines[lines.length - 1]).toBe('// trailing line'); // at EOF, not before the marker
  });
});

// nc:run substitutes prompted {{vars}} — this is what lets wiring be "collect
// input + call ncl", with no nc:wire directive.
const RUN_WIRE_SKILL = `# run-substitute demo

## Collect input
\`\`\`nc:prompt owner_email
Your email.
\`\`\`

## Wire via ncl
\`\`\`nc:run effect:wire
ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0
ncl messaging-groups send --channel-type resend --platform-id resend:{{owner_email}} --text "hello"
\`\`\`

## A var-free build run
\`\`\`nc:run effect:build
pnpm run build
\`\`\`
`;

describe('nc:run variable substitution', () => {
  let rroot: string;
  let rskill: string;
  beforeEach(() => {
    rskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    rroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(rskill, 'SKILL.md'), RUN_WIRE_SKILL);
    writeFileSync(join(rroot, 'package.json'), '{"name":"scratch"}');
  });

  it('interpolates a prompted {{var}} into run commands; var-free runs pass through unchanged', async () => {
    const { cmds, exec } = recordingExec();
    await applySkill(rskill, rroot, { prompter: headless({ owner_email: 'you@example.com' }), exec });
    expect(cmds).toContain(
      'ncl messaging-groups create --channel-type resend --platform-id resend:you@example.com --is-group 0',
    );
    expect(cmds).toContain(
      'ncl messaging-groups send --channel-type resend --platform-id resend:you@example.com --text "hello"',
    );
    expect(cmds).toContain('pnpm run build');
  });

  it('journals the ORIGINAL command (placeholders intact) — a substituted value never lands in the journal', async () => {
    const res = await applySkill(rskill, rroot, { prompter: headless({ owner_email: 'you@example.com' }), exec: () => {} });
    const ran = res.journal.filter((e) => e.op === 'ran').map((e) => 'cmd' in e ? e.cmd : '');
    expect(ran).toContain(
      'ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0',
    );
    expect(JSON.stringify(res.journal)).not.toContain('you@example.com');
  });

  it('defers a wiring run when its {{var}} prompt is unanswered (degrade, not crash)', async () => {
    const { cmds, exec } = recordingExec();
    const res = await applySkill(rskill, rroot, { prompter: headless({}), exec });
    expect(res.deferred.some((d) => /unresolved \{\{owner_email\}\}/.test(d))).toBe(true);
    expect(cmds.some((c) => c.startsWith('ncl'))).toBe(false); // no ncl ran with an unresolved value
    expect(cmds).toContain('pnpm run build'); // the var-free run still executes
  });
});

// capture: a run binds its stdout into a {{var}}, the twin of prompt. This is
// what lets a flow resolve a value from an API (Slack conversations.open) and
// feed it downstream — so even slack.ts's bespoke steps are pure directives.
const CAPTURE_SKILL = `# capture demo

## Collect
\`\`\`nc:prompt user_id
Your member id.
\`\`\`

## Resolve an id from a command, then wire with it
\`\`\`nc:run capture:dm_channel effect:fetch
resolve-dm {{user_id}}
\`\`\`
\`\`\`nc:run effect:wire
ncl messaging-groups create --channel-type slack --platform-id slack:{{dm_channel}}
\`\`\`
`;

describe('nc:run capture', () => {
  let croot: string;
  let cskill: string;
  beforeEach(() => {
    cskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    croot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(cskill, 'SKILL.md'), CAPTURE_SKILL);
    writeFileSync(join(croot, 'package.json'), '{"name":"scratch"}');
  });

  it('binds a command stdout (trimmed) into {{var}} and substitutes it downstream', async () => {
    const cmds: string[] = [];
    // exec returns stdout for the resolve command (simulating `… | jq -r .channel.id`).
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('resolve-dm')) return 'D0SLACK123\n';
    };
    await applySkill(cskill, croot, { prompter: headless({ user_id: 'U999' }), exec });
    expect(cmds).toContain('resolve-dm U999'); // resolved with the prompted id
    expect(cmds).toContain('ncl messaging-groups create --channel-type slack --platform-id slack:D0SLACK123'); // captured value flowed downstream
  });

  it('lint accepts {{dm_channel}} as defined by the earlier capture', () => {
    expect(validate(parseDirectives(CAPTURE_SKILL))).toEqual([]);
  });
});

// Multi-field JSON capture: a `capture:a=.x,b=.owner.id` on an effect:fetch parses
// the command's stdout as JSON and binds each var to its jq-style dot-path — so ONE
// API call (Discord's /oauth2/applications/@me) resolves several values at once.
// A single `capture:var` (no =) still binds stdout as-is. validate:<re> shape-guards
// a captured value; a mismatch bounces to an agent (a command's output has no human
// to re-prompt). effect:step's terminal-block field capture (distinguished by
// effect) is untouched — see the effect:step describe above.
const MULTI_CAPTURE_SKILL = `# multi-field capture demo

## Derive three values from one call
\`\`\`nc:run capture:application_id=.id,public_key=.verify_key,owner_handle=.owner.id effect:fetch
curl -sf https://example/app
\`\`\`

## Store the derived values
\`\`\`nc:env-set
APP_ID={{application_id}}
PUB_KEY={{public_key}}
\`\`\`
`;

const CAPTURE_VALIDATE_SKILL = `# capture validate demo

## Resolve an id that must be numeric
\`\`\`nc:run capture:app_id=.id effect:fetch validate:^\\d+$
curl -sf https://example/app
\`\`\`

## Use it
\`\`\`nc:env-set
APP_ID={{app_id}}
\`\`\`
`;

describe('nc:run multi-field JSON capture + validate', () => {
  let mroot: string;
  let mskill: string;
  beforeEach(() => {
    mskill = mkdtempSync(join(tmpdir(), 'nc-multi-skill-'));
    mroot = mkdtempSync(join(tmpdir(), 'nc-multi-proj-'));
    writeFileSync(join(mroot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(mroot, '.env'), '');
  });

  it('binds three vars from one JSON stdout via dot-paths (incl. a nested .owner.id) and feeds them downstream', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), MULTI_CAPTURE_SKILL);
    const json = JSON.stringify({ id: '111111111111111111', verify_key: 'abc123', owner: { id: '999999999999999999' } });
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => json + '\n' });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.application_id).toBe('111111111111111111');
    expect(res.vars.public_key).toBe('abc123');
    expect(res.vars.owner_handle).toBe('999999999999999999'); // nested dot-path resolved
    const env = readFileSync(join(mroot, '.env'), 'utf8');
    expect(env).toContain('APP_ID=111111111111111111'); // flowed into env-set
    expect(env).toContain('PUB_KEY=abc123');
  });

  it('lint registers each capture:<var>=<dot-path> var as defined for the downstream env-set', () => {
    expect(validate(parseDirectives(MULTI_CAPTURE_SKILL))).toEqual([]);
  });

  it('single capture:<var> (no =) still binds stdout as-is — unchanged', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), '# single\n\n```nc:run capture:dm effect:fetch\nresolve\n```\n```nc:env-set\nDM={{dm}}\n```\n');
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => 'D123\n' });
    expect(res.vars.dm).toBe('D123');
    expect(readFileSync(join(mroot, '.env'), 'utf8')).toContain('DM=D123');
  });

  it('a validate mismatch on a captured value bounces to an agent — never binds the var', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), CAPTURE_VALIDATE_SKILL);
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => JSON.stringify({ id: 'not-a-number' }) });
    expect(res.agentTasks).toHaveLength(1); // bounce, not re-ask
    expect(res.agentTasks[0].kind).toBe('run');
    expect(res.vars.app_id).toBeUndefined(); // validate failed before binding
    // the downstream env-set then defers on the unresolved {{app_id}}
    expect(res.deferred.some((d) => /unresolved \{\{app_id\}\}/.test(d))).toBe(true);
    expect(readFileSync(join(mroot, '.env'), 'utf8')).not.toContain('APP_ID=');
  });

  it('a validate match binds the captured value and applies clean', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), CAPTURE_VALIDATE_SKILL);
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => JSON.stringify({ id: '42' }) });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.app_id).toBe('42');
  });

  it('unparseable JSON stdout for a multi-field capture bounces (degrade, not crash)', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), MULTI_CAPTURE_SKILL);
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => 'not json at all' });
    expect(res.agentTasks).toHaveLength(1);
    expect(res.vars.application_id).toBeUndefined();
  });
});

// operator: the parts addressed to the human (UI steps), delineated so the agent
// relays them and the engine renders them — the output twin of prompt.
describe('nc:operator', () => {
  let oroot: string;
  let oskill: string;
  beforeEach(() => {
    oskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    oroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(oroot, 'package.json'), '{"name":"scratch"}');
  });

  it('relays the operator body to prompter.tell, substituting {{vars}}', async () => {
    writeFileSync(
      join(oskill, 'SKILL.md'),
      '# op demo\n\n```nc:prompt who\nName?\n```\nTell the user:\n```nc:operator\nHello {{who}} — go click the button.\n```\n',
    );
    const told: string[] = [];
    const prompter: Prompter = { async ask() { return 'world'; }, tell: (t) => void told.push(t) };
    await applySkill(oskill, oroot, { prompter, exec: () => {} });
    expect(told).toEqual(['Hello world — go click the button.']);
  });

  it('is a no-op when no operator sink is present (headless rebuild) — not a crash, not an agent bounce', async () => {
    writeFileSync(join(oskill, 'SKILL.md'), '# op demo\n\nTell the user:\n```nc:operator\nDo a manual thing.\n```\n');
    const res = await applySkill(oskill, oroot, { prompter: headless({}), exec: () => {} });
    expect(res.agentTasks).toEqual([]); // operator with no sink is fine, not bounced
  });
});

// Programmatic apply: pass every prompt answer via `inputs` and the whole skill
// runs through with no prompter and no human interaction.
const PROGRAMMATIC_SKILL = `# programmatic demo

## Collect
\`\`\`nc:prompt owner
Your name.
\`\`\`

## A human step (collected, not blocking)
Tell the user:
\`\`\`nc:operator
Go create the thing, {{owner}}.
\`\`\`

## Resolve from a command, then wire
\`\`\`nc:run capture:thing_id effect:fetch
resolve-thing {{owner}}
\`\`\`
\`\`\`nc:run effect:wire
ncl wire --owner {{owner}} --thing {{thing_id}}
\`\`\`
`;

describe('programmatic apply via inputs', () => {
  let proot: string;
  let pskill: string;
  beforeEach(() => {
    pskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    proot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(proot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(proot, '.env'), '');
  });

  it('runs the whole skill from inputs alone — no prompter, nothing deferred or bounced', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), PROGRAMMATIC_SKILL);
    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('resolve-thing')) return 'T-42\n';
    };
    const res = await applySkill(pskill, proot, { inputs: { owner: 'ada' }, exec });
    expect(fullyApplied(res)).toBe(true);
    expect(res.deferred).toEqual([]);
    expect(res.agentTasks).toEqual([]);
    expect(cmds).toContain('resolve-thing ada'); // prompt input flowed through
    expect(cmds).toContain('ncl wire --owner ada --thing T-42'); // captured value flowed through
    expect(res.operatorMessages).toEqual(['Go create the thing, ada.']); // human step collected for relay
  });

  it('reports a missing input as deferred — fullyApplied is false, not a crash', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), PROGRAMMATIC_SKILL);
    const res = await applySkill(pskill, proot, { inputs: {}, exec: () => {} });
    expect(fullyApplied(res)).toBe(false);
    expect(res.deferred).toContain('owner');
  });

  it('inputs win over the prompter; the prompter only fills the gaps', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), '# two prompts\n\n```nc:prompt a\nA?\n```\n```nc:prompt b\nB?\n```\n```nc:env-set\nA={{a}}\nB={{b}}\n```\n');
    const asked: string[] = [];
    const prompter: Prompter = { async ask(n) { asked.push(n); return 'fromPrompter'; } };
    await applySkill(pskill, proot, { inputs: { a: 'fromInputs' }, prompter, exec: () => {} });
    const env = readFileSync(join(proot, '.env'), 'utf8');
    expect(env).toContain('A=fromInputs'); // input wins
    expect(env).toContain('B=fromPrompter'); // prompter filled the gap
    expect(asked).toEqual(['b']); // 'a' was never asked — it came from inputs
  });

  it('skipEffects skips a run the caller owns (effect:restart) but runs the rest', async () => {
    writeFileSync(
      join(pskill, 'SKILL.md'),
      '# restart demo\n\n```nc:run effect:build\npnpm run build\n```\n```nc:run effect:restart\nbash setup/lib/restart.sh\n```\n```nc:run effect:wire\nncl wire\n```\n',
    );
    const cmds: string[] = [];
    const res = await applySkill(pskill, proot, { inputs: {}, skipEffects: ['restart'], exec: (c) => void cmds.push(c) });
    expect(cmds).toContain('pnpm run build');
    expect(cmds).toContain('ncl wire');
    expect(cmds).not.toContain('bash setup/lib/restart.sh'); // restart owned by the caller → skipped
    expect(res.skipped.some((s) => /run restart: owned by the caller/.test(s))).toBe(true);
  });

  it('threads a prompt validate:<re> through to the prompter', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), '# v\n\n```nc:prompt token secret validate:^xoxb-\nPaste.\n```\n');
    let seenValidate: string | undefined;
    const prompter: Prompter = {
      async ask(_name, _q, _secret, validate) {
        seenValidate = validate;
        return 'xoxb-ok';
      },
    };
    await applySkill(pskill, proot, { prompter, exec: () => {} });
    expect(seenValidate).toBe('^xoxb-');
  });

  it('exposes resolved non-secret vars (prompt answers + captures) but never secrets', async () => {
    writeFileSync(
      join(pskill, 'SKILL.md'),
      '# vars demo\n\n```nc:prompt token secret\nT?\n```\n```nc:prompt handle\nH?\n```\n```nc:run capture:addr\nresolve {{handle}}\n```\n',
    );
    const res = await applySkill(pskill, proot, { inputs: { token: 'SEKRET', handle: 'U9' }, exec: () => 'x:U9\n' });
    expect(res.vars.handle).toBe('U9'); // plain prompt answer exposed
    expect(res.vars.addr).toBe('x:U9'); // capture output exposed (a caller reads this)
    expect(res.vars.token).toBeUndefined(); // secret prompt NOT exposed
  });
});

// when: guards let one skill carry mutually-exclusive branches (a local vs
// remote install mode) in document order — the unmet branch is skipped, and a
// guarded prompt is skipped (not deferred) so the programmatic run still completes.
const MODE_SKILL = `# mode demo

## Pick a mode
\`\`\`nc:prompt mode
Pick local or remote.
\`\`\`

## Remote needs a server
\`\`\`nc:prompt server_url when:mode=remote
Photon server URL.
\`\`\`
\`\`\`nc:env-set when:mode=remote
IMESSAGE_SERVER_URL={{server_url}}
\`\`\`

## Local needs nothing extra
\`\`\`nc:env-set when:mode=local
IMESSAGE_LOCAL=true
\`\`\`
`;

function modeScratch(): { sdir: string; rdir: string } {
  const sdir = mkdtempSync(join(tmpdir(), 'nc-when-skill-'));
  const rdir = mkdtempSync(join(tmpdir(), 'nc-when-proj-'));
  writeFileSync(join(sdir, 'SKILL.md'), MODE_SKILL);
  writeFileSync(join(rdir, '.env'), '');
  writeFileSync(join(rdir, 'package.json'), '{"name":"scratch"}');
  return { sdir, rdir };
}

describe('when: guard', () => {
  it('local mode: the remote-guarded prompt + env-set are skipped, not deferred — fully programmatic', async () => {
    const { sdir, rdir } = modeScratch();
    const res = await applySkill(sdir, rdir, { inputs: { mode: 'local' }, exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
    expect(res.deferred).toEqual([]); // server_url was skipped by the guard, NOT deferred
    const env = readFileSync(join(rdir, '.env'), 'utf8');
    expect(env).toContain('IMESSAGE_LOCAL=true');
    expect(env).not.toContain('IMESSAGE_SERVER_URL');
    expect(res.skipped.some((s) => /when mode=remote/.test(s))).toBe(true);
  });

  it('remote mode: the remote branch applies, the local-only env-set is skipped', async () => {
    const { sdir, rdir } = modeScratch();
    const res = await applySkill(sdir, rdir, { inputs: { mode: 'remote', server_url: 'https://photon.example' }, exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
    const env = readFileSync(join(rdir, '.env'), 'utf8');
    expect(env).toContain('IMESSAGE_SERVER_URL=https://photon.example');
    expect(env).not.toContain('IMESSAGE_LOCAL');
  });

  it('a guarded prompt with no input does not defer when its guard is unmet (the programmatic-run contract)', async () => {
    const { sdir, rdir } = modeScratch();
    // local mode, server_url neither supplied nor answerable — must still complete.
    const res = await applySkill(sdir, rdir, { inputs: { mode: 'local' }, prompter: headless({}), exec: () => {} });
    expect(res.deferred).toEqual([]);
    expect(fullyApplied(res)).toBe(true);
  });
});

// effect:step runs a long-running, operator-interactive step (a pairing code, a
// QR device-link) through the injected streaming exec and binds the terminal
// block's named fields via capture:<var>=<FIELD>,… — the structured twin of
// stdout capture. With no streaming exec it degrades to an agent.
const STEP_SKILL = `# step demo

## Link the device
\`\`\`nc:run effect:step capture:platform_id=PLATFORM_ID,owner_handle=ADMIN_ID
pnpm exec tsx setup/index.ts --step pair-demo
\`\`\`

## Use what the step resolved
\`\`\`nc:env-set
DEMO_PLATFORM={{platform_id}}
\`\`\`
`;

function stepScratch(): { sdir: string; rdir: string } {
  const sdir = mkdtempSync(join(tmpdir(), 'nc-step-skill-'));
  const rdir = mkdtempSync(join(tmpdir(), 'nc-step-proj-'));
  writeFileSync(join(sdir, 'SKILL.md'), STEP_SKILL);
  writeFileSync(join(rdir, '.env'), '');
  writeFileSync(join(rdir, 'package.json'), '{"name":"scratch"}');
  return { sdir, rdir };
}

describe('nc:run effect:step (streaming, multi-field capture)', () => {
  it('binds the terminal block fields into vars and substitutes them downstream', async () => {
    const { sdir, rdir } = stepScratch();
    const seen: string[] = [];
    const execStream = async (cmd: string) => {
      seen.push(cmd);
      return { ok: true, fields: { STATUS: 'success', PLATFORM_ID: 'telegram:12345', ADMIN_ID: '67890' } };
    };
    const res = await applySkill(sdir, rdir, { exec: () => {}, execStream });
    expect(fullyApplied(res)).toBe(true);
    expect(seen).toEqual(['pnpm exec tsx setup/index.ts --step pair-demo']);
    expect(res.vars.platform_id).toBe('telegram:12345'); // both fields captured…
    expect(res.vars.owner_handle).toBe('67890');
    expect(readFileSync(join(rdir, '.env'), 'utf8')).toContain('DEMO_PLATFORM=telegram:12345'); // …and consumed downstream
  });

  it('degrades to an agent when no streaming exec is wired (not a crash)', async () => {
    const { sdir, rdir } = stepScratch();
    const res = await applySkill(sdir, rdir, { exec: () => {} }); // no execStream
    expect(res.agentTasks).toHaveLength(1);
    expect(res.agentTasks[0].kind).toBe('run');
    expect(res.deferred.some((d) => /platform_id/.test(d))).toBe(true); // downstream env-set then defers
  });

  it('a failed step bounces to an agent rather than capturing empty values', async () => {
    const { sdir, rdir } = stepScratch();
    const res = await applySkill(sdir, rdir, { exec: () => {}, execStream: async () => ({ ok: false, fields: {} }) });
    expect(res.agentTasks).toHaveLength(1);
    expect(res.vars.platform_id).toBeUndefined();
  });
});

// Run-health gate: once any directive bounces (a real failure, not a deferred
// prompt), the dangerous side effects — a live restart, an interactive
// pairing/QR step, a wire — must not fire on their own. They bounce too, so the
// agent finishes them from the prose after fixing the upstream failure. This is
// what stops a doomed QR / a pointless restart after a bad credential.
const GATE_SKILL = `# gate demo

## Validate the credential first
\`\`\`nc:run capture:who effect:fetch
verify-cred
\`\`\`

## Restart the service
\`\`\`nc:run effect:restart
bash restart.sh
\`\`\`

## Link the device (interactive)
\`\`\`nc:run effect:step capture:platform_id=PLATFORM_ID
pnpm exec tsx setup/index.ts --step pair
\`\`\`
`;

// A deferred prompt is NOT a failure: the headless rebuild leaves it (and its
// {{var}} consumer) unresolved, but a later restart must still be runnable.
const DEFER_THEN_RESTART_SKILL = `# defer then restart demo

## Collect a token
\`\`\`nc:prompt token secret
Paste it.
\`\`\`
\`\`\`nc:env-set
TOK={{token}}
\`\`\`

## Restart the service
\`\`\`nc:run effect:restart
bash restart.sh
\`\`\`
`;

describe('run-health gate (a bounce blocks later side effects)', () => {
  let groot: string;
  let gskill: string;
  beforeEach(() => {
    gskill = mkdtempSync(join(tmpdir(), 'nc-gate-skill-'));
    groot = mkdtempSync(join(tmpdir(), 'nc-gate-proj-'));
    writeFileSync(join(groot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(groot, '.env'), '');
  });

  it('a failed effect:fetch blocks the later restart and step — they bounce, never execute', async () => {
    writeFileSync(join(gskill, 'SKILL.md'), GATE_SKILL);
    const cmds: string[] = [];
    const streamed: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c === 'verify-cred') throw new Error('401 bad credential'); // bad cred → bounce
    };
    const execStream = async (c: string) => {
      streamed.push(c);
      return { ok: true, fields: { PLATFORM_ID: 'x' } };
    };
    const res = await applySkill(gskill, groot, { inputs: {}, exec, execStream });

    // the fetch actually ran and threw — that's the first bounce
    expect(cmds).toContain('verify-cred');
    // the restart never executed (no live restart on a bad credential)…
    expect(cmds).not.toContain('bash restart.sh');
    // …and the interactive step never spawned (no doomed QR/pairing)
    expect(streamed).toEqual([]);

    // three agent tasks: the failed fetch + the two gated side effects
    expect(res.agentTasks).toHaveLength(3);
    const gated = res.agentTasks.filter((t) => /an earlier step did not complete/.test(t.reason));
    expect(gated).toHaveLength(2); // restart + step, both bounced by the gate
  });

  it('a deferred prompt does NOT block a later restart (headless rebuild stays runnable)', async () => {
    writeFileSync(join(gskill, 'SKILL.md'), DEFER_THEN_RESTART_SKILL);
    const cmds: string[] = [];
    const res = await applySkill(gskill, groot, { prompter: headless({}), exec: (c) => void cmds.push(c) });

    // the prompt and its consumer deferred (no answer headless) — not a failure
    expect(res.deferred).toContain('token');
    expect(res.deferred.some((d) => /unresolved \{\{token\}\}/.test(d))).toBe(true);
    expect(readFileSync(join(groot, '.env'), 'utf8')).not.toContain('TOK=');

    // the restart still runs, and nothing bounced
    expect(cmds).toContain('bash restart.sh');
    expect(res.agentTasks).toEqual([]);
  });
});

// effect:check runs the body as a shell PREDICATE — a precondition gate that
// mutates NOTHING (no journal, no capture). A non-zero exit bounces to an agent
// AND latches `blocked`, so a following dangerous side effect (a restart) is
// gated. An unresolved {{var}} defers (a headless rebuild before the value is
// collected). A zero exit is a silent pass.
const CHECK_GATE_SKILL = `# check gate demo

## Require macOS for local mode
\`\`\`nc:run effect:check
[ "$(uname)" = Darwin ]
\`\`\`

## Restart the service
\`\`\`nc:run effect:restart
bash restart.sh
\`\`\`
`;

const CHECK_VAR_SKILL = `# check var demo

## Collect the linked number
\`\`\`nc:prompt bot_phone
The linked number.
\`\`\`

## Guard the captured value before using it
\`\`\`nc:run effect:check
[ -n "{{bot_phone}}" ]
\`\`\`
`;

const CHECK_PASS_SKILL = `# check pass demo

## A precondition that passes
\`\`\`nc:run effect:check
true
\`\`\`
`;

describe('nc:run effect:check (precondition gate)', () => {
  let chkSkill: string;
  let chkRoot: string;
  beforeEach(() => {
    chkSkill = mkdtempSync(join(tmpdir(), 'nc-check-skill-'));
    chkRoot = mkdtempSync(join(tmpdir(), 'nc-check-proj-'));
    writeFileSync(join(chkRoot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(chkRoot, '.env'), '');
  });

  it('a non-zero check bounces to an agent and gates a following effect:restart', async () => {
    writeFileSync(join(chkSkill, 'SKILL.md'), CHECK_GATE_SKILL);
    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('[')) throw new Error('exit 1'); // predicate failed (non-zero)
    };
    const res = await applySkill(chkSkill, chkRoot, { inputs: {}, exec });

    expect(cmds).toContain('[ "$(uname)" = Darwin ]'); // the predicate actually ran
    expect(cmds).not.toContain('bash restart.sh'); // restart never executed — gated by the failed check
    // two agent tasks: the failed check itself + the gated restart
    expect(res.agentTasks).toHaveLength(2);
    expect(res.agentTasks[0].kind).toBe('run');
    expect(res.agentTasks.some((t) => /an earlier step did not complete/.test(t.reason))).toBe(true);
    expect(res.journal).toEqual([]); // a check mutates nothing
  });

  it('an unresolved {{var}} in a check defers (headless rebuild) — not a bounce', async () => {
    writeFileSync(join(chkSkill, 'SKILL.md'), CHECK_VAR_SKILL);
    const cmds: string[] = [];
    const res = await applySkill(chkSkill, chkRoot, { prompter: headless({}), exec: (c) => void cmds.push(c) });

    expect(res.deferred).toContain('bot_phone'); // the prompt deferred (no headless answer)
    expect(res.deferred.some((d) => /unresolved \{\{bot_phone\}\}/.test(d))).toBe(true); // the check deferred on it
    expect(res.agentTasks).toEqual([]); // a deferred check is NOT a failure — no bounce
    expect(cmds.some((c) => c.startsWith('['))).toBe(false); // the predicate never ran (var unresolved)
  });

  it('a zero-exit check is a no-op — no journal entry, no bounce, no defer', async () => {
    writeFileSync(join(chkSkill, 'SKILL.md'), CHECK_PASS_SKILL);
    const cmds: string[] = [];
    const res = await applySkill(chkSkill, chkRoot, { inputs: {}, exec: (c) => void cmds.push(c) });

    expect(cmds).toContain('true'); // the predicate ran
    expect(res.journal).toEqual([]); // mutated nothing — no 'ran' entry
    expect(res.agentTasks).toEqual([]);
    expect(res.deferred).toEqual([]);
  });

  it('lint accepts a check that guards an earlier-defined var', () => {
    expect(validate(parseDirectives(CHECK_VAR_SKILL))).toEqual([]);
  });
});

// The apply-lifecycle reporter brackets each real mutation (applyOne) with
// stepStart/stepEnd so the setup driver can spin on the slow ones. An effectful
// step (a run, a dep, a branch-fetch copy) carries a human label (the nearest
// heading); an instant step (a local copy, an env write) carries null so the
// driver stays silent. The engine fires the events; this asserts shape + order +
// timing + the failure path, all with no real clack involved.
const REPORTER_SKILL = `# reporter demo

## Verify the credential
\`\`\`nc:run effect:fetch
verify-cred
\`\`\`

## Store it
\`\`\`nc:env-set
DEMO=ok
\`\`\`
`;

type RecordedEvent =
  | { ev: 'start'; kind: string; label: string | null }
  | { ev: 'end'; kind: string; label: string | null; ok: boolean; durationMs: number; error?: string };

function recordingReporter(): { events: RecordedEvent[]; reporter: StepReporter } {
  const events: RecordedEvent[] = [];
  return {
    events,
    reporter: {
      stepStart: (e) => void events.push({ ev: 'start', kind: e.kind, label: e.label }),
      stepEnd: (e) =>
        void events.push({ ev: 'end', kind: e.kind, label: e.label, ok: e.ok, durationMs: e.durationMs, error: e.error }),
    },
  };
}

describe('apply-lifecycle reporter (driver spinners)', () => {
  let rroot: string;
  let rskill: string;
  beforeEach(() => {
    rskill = mkdtempSync(join(tmpdir(), 'nc-rep-skill-'));
    rroot = mkdtempSync(join(tmpdir(), 'nc-rep-proj-'));
    writeFileSync(join(rskill, 'SKILL.md'), REPORTER_SKILL);
    writeFileSync(join(rroot, '.env'), '');
    writeFileSync(join(rroot, 'package.json'), '{"name":"scratch"}');
  });

  it('fires stepStart/stepEnd in order; effectful step carries a heading label, instant step null', async () => {
    const { events, reporter } = recordingReporter();
    await applySkill(rskill, rroot, { exec: () => {}, reporter });

    // bracketed in document order: the run, then the env-set
    expect(events.map((e) => `${e.ev}:${e.kind}`)).toEqual([
      'start:run', 'end:run', 'start:env-set', 'end:env-set',
    ]);

    // the effectful run: the nearest heading is its spinner label, ok + numeric ms
    expect(events.find((e) => e.ev === 'start' && e.kind === 'run')?.label).toBe('Verify the credential');
    const runEnd = events.find((e): e is Extract<RecordedEvent, { ev: 'end' }> => e.ev === 'end' && e.kind === 'run')!;
    expect(runEnd.ok).toBe(true);
    expect(typeof runEnd.durationMs).toBe('number');
    expect(runEnd.durationMs).toBeGreaterThanOrEqual(0);

    // the instant env-set: null label ⇒ no spin
    expect(events.find((e) => e.ev === 'start' && e.kind === 'env-set')?.label).toBe(null);
  });

  it('on a failed step, fires stepEnd ok=false with the error — balanced with its start', async () => {
    const { events, reporter } = recordingReporter();
    const exec = (c: string): string | void => {
      if (c === 'verify-cred') throw new Error('401 bad credential');
    };
    const res = await applySkill(rskill, rroot, { exec, reporter });

    const runEnd = events.find((e): e is Extract<RecordedEvent, { ev: 'end' }> => e.ev === 'end' && e.kind === 'run')!;
    expect(runEnd.ok).toBe(false);
    expect(runEnd.error).toMatch(/401 bad credential/);
    // every stepStart has a matching stepEnd (the spinner is never left hanging)
    expect(events.filter((e) => e.ev === 'start')).toHaveLength(events.filter((e) => e.ev === 'end').length);
    // and the failure still degraded to an agent, not a crash
    expect(res.agentTasks).toHaveLength(1);
  });

  it('no reporter ⇒ silent (unchanged) — apply still completes', async () => {
    const res = await applySkill(rskill, rroot, { exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
  });
});

describe('stepLabel', () => {
  it('labels effectful kinds from the nearest heading, instant kinds null; label: attr overrides; step is silent', () => {
    const md = [
      '# s', '',
      '## Install deps', '```nc:dep', 'pkg@1.0.0', '```', '',
      '## Copy a file', '```nc:copy', 'a -> b', '```', '',
      '## Pull from the branch', '```nc:copy from-branch:channels', 'x -> y', '```', '',
      '## Link the device', '```nc:run effect:step capture:platform_id=PLATFORM_ID', 'pair', '```', '',
      '## Wire it', '```nc:run effect:wire label:Connecting', 'ncl wire', '```',
    ].join('\n');
    const ds = parseDirectives(md);
    const nth = (k: string, i = 0) => ds.filter((d) => d.kind === k)[i];
    expect(stepLabel(nth('dep'), md)).toBe('Install deps');               // heading-derived
    expect(stepLabel(nth('copy', 0), md)).toBe(null);                     // local copy = instant
    expect(stepLabel(nth('copy', 1), md)).toBe('Pull from the branch');   // from-branch fetch spins
    expect(stepLabel(nth('run', 0), md)).toBe(null);                      // effect:step renders its own live output
    expect(stepLabel(nth('run', 1), md)).toBe('Connecting');             // label: attr overrides the heading
  });

  it('falls back to a kind/effect default when there is no heading above the fence', () => {
    const ds = parseDirectives('```nc:run effect:build\npnpm run build\n```\n');
    expect(stepLabel(ds[0], '```nc:run effect:build\npnpm run build\n```\n')).toBe('Building');
  });
});

// firstFailureHint surfaces the prose beside the FIRST bounced directive as the
// operator's failure hint (the setup driver threads it into fail() + the Claude
// handoff). The hint defaults to the surrounding prose; an `on-fail:<token>` attr
// on the fence narrows it to the single prose LINE that diagnoses the failure —
// and because that attr is stripped when a skill degrades to prose, the SAME
// diagnosis must already live in the prose, so a token with no matching prose
// line falls back to the full prose (prose-primary, never a leak).
const FAIL_HINT_SKILL = `# connect demo

## Verify the credential
The bot token must be valid. If auth.test fails, the token is wrong or the app isn't installed in the workspace.
\`\`\`nc:hand-verify
check the token
\`\`\`
`;

const ON_FAIL_SKILL = `# connect demo

## Connect to the service
Install the app, then paste the bot token below.
If auth.test returns invalid_auth, your token is wrong — regenerate it from the OAuth page.
\`\`\`nc:hand-verify on-fail:invalid_auth
check the token
\`\`\`
`;

const ON_FAIL_MISS_SKILL = `# connect demo

## Connect
Do the manual connection step in the dashboard.
\`\`\`nc:hand-verify on-fail:nonexistent_token
check
\`\`\`
`;

const NO_BOUNCE_SKILL = `# prompt only

## Collect a token
\`\`\`nc:prompt token secret
Paste it.
\`\`\`
`;

describe('firstFailureHint', () => {
  let froot: string;
  let fskill: string;
  beforeEach(() => {
    fskill = mkdtempSync(join(tmpdir(), 'nc-fh-skill-'));
    froot = mkdtempSync(join(tmpdir(), 'nc-fh-proj-'));
    writeFileSync(join(froot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(froot, '.env'), '');
  });

  it('returns the heading as a headline and the bounced step prose as the hint', async () => {
    writeFileSync(join(fskill, 'SKILL.md'), FAIL_HINT_SKILL);
    const res = await applySkill(fskill, froot, { inputs: {}, exec: () => {} });
    expect(res.agentTasks).toHaveLength(1); // the unknown directive bounced
    const diag = firstFailureHint(res);
    expect(diag?.headline).toBe('Verify the credential'); // the section heading, # stripped
    expect(diag?.hint).toContain('the token is wrong'); // the prose beside the step
    // the AgentTask carries the same hint (default = trimmed prose)
    expect(res.agentTasks[0].hint).toBe(diag?.hint);
  });

  it('an on-fail:<token> narrows the hint to the prose line that diagnoses the failure', async () => {
    writeFileSync(join(fskill, 'SKILL.md'), ON_FAIL_SKILL);
    const res = await applySkill(fskill, froot, { inputs: {}, exec: () => {} });
    const diag = firstFailureHint(res);
    expect(diag?.headline).toBe('Connect to the service');
    // narrowed to the single diagnosing line — not the whole paragraph
    expect(diag?.hint).toBe('If auth.test returns invalid_auth, your token is wrong — regenerate it from the OAuth page.');
    expect(diag?.hint).not.toContain('Install the app');
  });

  it('falls back to the full prose when the on-fail token has no matching prose line (no leak)', async () => {
    writeFileSync(join(fskill, 'SKILL.md'), ON_FAIL_MISS_SKILL);
    const res = await applySkill(fskill, froot, { inputs: {}, exec: () => {} });
    const diag = firstFailureHint(res);
    // the bare token never surfaces — the operator sees the prose
    expect(diag?.hint).toContain('Do the manual connection step in the dashboard.');
    expect(diag?.hint).not.toContain('nonexistent_token');
  });

  it('returns undefined when nothing bounced (a deferred prompt is not a failure)', async () => {
    writeFileSync(join(fskill, 'SKILL.md'), NO_BOUNCE_SKILL);
    const res = await applySkill(fskill, froot, { prompter: headless({}), exec: () => {} });
    expect(res.deferred).toContain('token'); // deferred, not bounced
    expect(res.agentTasks).toEqual([]);
    expect(firstFailureHint(res)).toBeUndefined();
  });
});

// PromptOpts: `nc:prompt` attrs (flags/min/error/normalize). `normalize:<how>` is
// applied DETERMINISTICALLY at engine bind — to BOTH an `inputs` value and an
// interactive answer — so they land identically (a deliberate behavior change).
// flags/min/error are carried through to the prompter (their interactive
// enforcement is asserted in skill-driver.test.ts against promptValidator).
const NORMALIZE_SKILL = `# normalize demo

## Collect a base URL
\`\`\`nc:prompt public_url normalize:rstrip-slash
Paste your base URL.
\`\`\`
\`\`\`nc:env-set
PUBLIC_URL={{public_url}}
\`\`\`
`;

describe('nc:prompt PromptOpts (normalize at bind, opts threading)', () => {
  let nroot: string;
  let nskill: string;
  beforeEach(() => {
    nskill = mkdtempSync(join(tmpdir(), 'nc-opts-skill-'));
    nroot = mkdtempSync(join(tmpdir(), 'nc-opts-proj-'));
    writeFileSync(join(nskill, 'SKILL.md'), NORMALIZE_SKILL);
    writeFileSync(join(nroot, '.env'), '');
    writeFileSync(join(nroot, 'package.json'), '{"name":"scratch"}');
  });

  it('normalize:rstrip-slash strips a trailing slash on an inputs value (bound + consumed downstream)', async () => {
    const res = await applySkill(nskill, nroot, { inputs: { public_url: 'https://x.ngrok.io/' }, exec: () => {} });
    expect(res.vars.public_url).toBe('https://x.ngrok.io'); // slash stripped at bind
    expect(readFileSync(join(nroot, '.env'), 'utf8')).toContain('PUBLIC_URL=https://x.ngrok.io');
  });

  it('normalize:rstrip-slash strips a trailing slash on an interactive answer too (same bind path)', async () => {
    const res = await applySkill(nskill, nroot, { prompter: headless({ public_url: 'https://x.ngrok.io/' }), exec: () => {} });
    expect(res.vars.public_url).toBe('https://x.ngrok.io'); // identical to the inputs path
    expect(readFileSync(join(nroot, '.env'), 'utf8')).toContain('PUBLIC_URL=https://x.ngrok.io');
  });

  it('threads validate + PromptOpts (flags/min/normalize) through to the prompter, then normalizes the answer at bind', async () => {
    writeFileSync(
      join(nskill, 'SKILL.md'),
      '# o\n\n```nc:prompt url validate:^https?:// flags:i min:5 normalize:rstrip-slash\nURL?\n```\n',
    );
    let seenValidate: string | undefined;
    let seenOpts: PromptOpts | undefined;
    const prompter: Prompter = {
      async ask(_n, _q, _s, validate, opts) {
        seenValidate = validate;
        seenOpts = opts;
        return 'HTTPS://x.io/'; // the prompter returns the raw answer; the engine normalizes
      },
    };
    const res = await applySkill(nskill, nroot, { prompter, exec: () => {} });
    expect(seenValidate).toBe('^https?://');
    expect(seenOpts).toMatchObject({ flags: 'i', min: 5, normalize: 'rstrip-slash' });
    // normalize applied at bind (trailing slash gone); case preserved (lower not set)
    expect(res.vars.url).toBe('HTTPS://x.io');
  });

  it('normalize:lower and trim also bind deterministically', async () => {
    writeFileSync(
      join(nskill, 'SKILL.md'),
      '# n\n\n```nc:prompt a normalize:lower\nA?\n```\n```nc:prompt b normalize:trim\nB?\n```\n',
    );
    const res = await applySkill(nskill, nroot, { inputs: { a: 'MixedCASE', b: '  spaced  ' }, exec: () => {} });
    expect(res.vars.a).toBe('mixedcase');
    expect(res.vars.b).toBe('spaced');
  });
});

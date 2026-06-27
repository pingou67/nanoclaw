import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDirectives, validate, promptVar, resolveChatCoreVersion } from './skill-directives.js';

// Guards the structured-directive format against the converted add-slack skill:
// red if the conversion drifts (a directive dropped/renamed) or the parser breaks.
const slack = readFileSync('.claude/skills/add-slack/SKILL.md', 'utf8');
const directives = parseDirectives(slack);

describe('skill-directives parser, on the converted add-slack', () => {
  it('extracts every directive in document order — install, credentials, resolve, restart', () => {
    expect(directives.map((d) => d.kind)).toEqual([
      'copy', // step 1: adapter + test from the channels branch
      'append', // step 2: barrel registration
      'dep', // step 3: pinned package
      'run', // step 4: build
      'run', // step 4: test
      'operator', // credentials: create-app walkthrough (addressed to the operator)
      'prompt', // credentials: capture bot token
      'prompt', // credentials: capture signing secret
      'env-set', // credentials: write captured values to .env
      'env-sync', // credentials: sync to container
      'operator', // credentials: event-delivery walkthrough
      'prompt', // resolve: owner member id (owner_handle)
      'run', // resolve: validate token (auth.test) — fast-fail before the restart
      'run', // resolve: DM channel (conversations.open → capture:platform_id)
      'run', // restart: load the adapter + creds once the credential is validated
    ]);
    // The wire (owner role, messaging-group, wiring, /welcome) is NOT in the
    // skill — it's the shared init-first-agent, called by the setup flow.
    expect(directives.some((d) => d.attrs.effect === 'wire')).toBe(false);
  });

  it('delineates the human UI steps as nc:operator (not agent prose or a run)', () => {
    const ops = directives.filter((d) => d.kind === 'operator');
    expect(ops).toHaveLength(2);
    expect(ops[0].body.join('\n')).toMatch(/Create the Slack app/);
    expect(ops[0].body.join('\n')).toMatch(/Bot Token Scopes/);
    expect(ops[1].body.join('\n')).toMatch(/Event Subscriptions/);
  });

  it('reads copy as a branch fetch with both files', () => {
    const copy = directives.find((d) => d.kind === 'copy')!;
    expect(copy.attrs['from-branch']).toBe('channels');
    expect(copy.body).toEqual(['src/channels/slack.ts', 'src/channels/slack-registration.test.ts']);
  });

  it('reads the barrel append target and line', () => {
    const append = directives.find((d) => d.kind === 'append')!;
    expect(append.attrs.to).toBe('src/channels/index.ts');
    expect(append.body).toEqual(["import './slack.js';"]);
  });

  it('reads the dependency pinned exactly', () => {
    const dep = directives.find((d) => d.kind === 'dep')!;
    expect(dep.body).toEqual(['@chat-adapter/slack@4.26.0']);
  });

  it('tags the runs with their effects', () => {
    expect(directives.filter((d) => d.kind === 'run').map((d) => d.attrs.effect)).toEqual([
      'build',
      'test',
      'fetch', // validate: auth.test — credential checked first
      'fetch', // resolve: conversations.open
      'restart', // load adapter + creds after the credential is validated, before wiring
    ]);
  });

  it('captures prompts into named vars — credentials secret, the handle not', () => {
    const prompts = directives.filter((d) => d.kind === 'prompt');
    expect(prompts.map(promptVar)).toEqual(['bot_token', 'signing_secret', 'owner_handle']);
    expect(prompts[0].args).toContain('secret'); // bot_token
    expect(prompts[1].args).toContain('secret'); // signing_secret
    expect(prompts[2].args).not.toContain('secret'); // owner_handle — a plain id, not a secret
    // The prompt body is the question; it does not mention env at all.
    expect(prompts[0].body.join(' ')).toMatch(/Bot User OAuth Token/);
  });

  it('resolves the conversation address into capture:platform_id (the wire input)', () => {
    const runs = directives.filter((d) => d.kind === 'run');
    const resolve = runs.find((d) => d.attrs.capture === 'platform_id')!;
    expect(resolve).toBeTruthy();
    expect(resolve.body.join(' ')).toMatch(/conversations\.open/);
    expect(resolve.body.join(' ')).toMatch(/"slack:" \+ \.channel\.id/); // emits the slack:<id> platform_id
  });

  it('wires the captured variables into env-set via {{var}} references', () => {
    const envSet = directives.find((d) => d.kind === 'env-set')!;
    expect(envSet.body).toEqual(['SLACK_BOT_TOKEN={{bot_token}}', 'SLACK_SIGNING_SECRET={{signing_secret}}']);
  });

  it('passes validation (well-formed, pinned, every {{var}} captured first)', () => {
    expect(validate(directives)).toEqual([]);
  });

  it('keeps its @chat-adapter pin in sync with our chat core (drift guard)', () => {
    const chat = resolveChatCoreVersion(process.cwd());
    expect(chat).toMatch(/^\d+\.\d+\.\d+/); // our lockfile resolves a real chat version
    expect(validate(directives, { chatVersion: chat })).toEqual([]); // add-slack matches it
  });

  it('ignores plain (non-nc:) code fences so prose stays the floor', () => {
    const withProse = slack + '\n```bash\nrm -rf /\n```\n';
    expect(parseDirectives(withProse).map((d) => d.kind)).toEqual(directives.map((d) => d.kind));
  });
});

describe('validation catches malformed directives', () => {
  it('flags an unpinned dependency and an unknown directive', () => {
    const md = ['```nc:dep', '@chat-adapter/slack@latest', '```', '', '```nc:frobnicate', 'x', '```'].join('\n');
    const problems = validate(parseDirectives(md));
    expect(problems.some((p) => /exact semver/.test(p.message))).toBe(true);
    expect(problems.some((p) => /unknown directive/.test(p.message))).toBe(true);
  });

  it('flags an env-set that references a variable no prompt captured', () => {
    const md = ['```nc:env-set', 'SLACK_BOT_TOKEN={{bot_token}}', '```'].join('\n');
    const problems = validate(parseDirectives(md));
    expect(problems.some((p) => /\{\{bot_token\}\} but no earlier nc:prompt/.test(p.message))).toBe(true);
  });

  it('flags a @chat-adapter pin that does not match the chat core', () => {
    const md = ['```nc:dep', '@chat-adapter/slack@4.27.0', '```'].join('\n');
    const problems = validate(parseDirectives(md), { chatVersion: '4.26.0' });
    expect(problems.some((p) => /must match the chat package/.test(p.message))).toBe(true);
  });

  it('accepts a @chat-adapter pin that matches the chat core', () => {
    const md = ['```nc:dep', '@chat-adapter/slack@4.26.0', '```'].join('\n');
    expect(validate(parseDirectives(md), { chatVersion: '4.26.0' })).toEqual([]);
  });
});

describe('json-merge directive', () => {
  const codex = ['```nc:json-merge into:container/cli-tools.json key:name', '{ "name": "@openai/codex", "version": "0.138.0" }', '```'].join('\n');

  it('parses into/key attrs and the JSON object body', () => {
    const [d] = parseDirectives(codex);
    expect(d.kind).toBe('json-merge');
    expect(d.attrs.into).toBe('container/cli-tools.json');
    expect(d.attrs.key).toBe('name');
    expect(JSON.parse(d.body.join('\n'))).toEqual({ name: '@openai/codex', version: '0.138.0' });
  });

  it('passes validation when into + key + a parseable object are all present', () => {
    expect(validate(parseDirectives(codex))).toEqual([]);
  });

  it('flags a missing into:', () => {
    const md = ['```nc:json-merge key:name', '{ "name": "x" }', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /requires into:/.test(p.message))).toBe(true);
  });

  it('flags a missing key:', () => {
    const md = ['```nc:json-merge into:container/cli-tools.json', '{ "name": "x" }', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /requires key:/.test(p.message))).toBe(true);
  });

  it('flags an unparseable body', () => {
    const md = ['```nc:json-merge into:f.json key:name', '{ not json', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /parseable JSON object/.test(p.message))).toBe(true);
  });

  it('flags a body that is an array, not a single object', () => {
    const md = ['```nc:json-merge into:f.json key:name', '[{ "name": "x" }]', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /single JSON object/.test(p.message))).toBe(true);
  });

  it('flags a body missing the match key field', () => {
    const md = ['```nc:json-merge into:f.json key:name', '{ "version": "1.0.0" }', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /no "name" field/.test(p.message))).toBe(true);
  });
});

describe('append at:<marker> attribute', () => {
  it('parses an optional at:<marker> alongside to:', () => {
    const md = ['```nc:append to:setup/index.ts at:nanoclaw:setup-steps', "  codex: () => import('./codex.js'),", '```'].join('\n');
    const [d] = parseDirectives(md);
    expect(d.kind).toBe('append');
    expect(d.attrs.to).toBe('setup/index.ts');
    expect(d.attrs.at).toBe('nanoclaw:setup-steps');
  });

  it('still validates an append that carries at: (to + a line are all it needs)', () => {
    const md = ['```nc:append to:setup/index.ts at:nanoclaw:setup-steps', "  codex: () => import('./codex.js'),", '```'].join('\n');
    expect(validate(parseDirectives(md))).toEqual([]);
  });
});

describe('when: guard + multi-field capture', () => {
  it('parses when: into attrs and lints a guard whose var an earlier prompt defined', () => {
    const md = ['```nc:prompt mode', 'local or remote', '```', '```nc:prompt server_url when:mode=remote', 'url', '```'].join('\n');
    const ds = parseDirectives(md);
    expect(ds[1].attrs.when).toBe('mode=remote');
    expect(validate(ds)).toEqual([]);
  });

  it('flags a when: guard whose var no earlier prompt/capture defined', () => {
    const probs = validate(parseDirectives(['```nc:env-set when:mode=remote', 'X=1', '```'].join('\n')));
    expect(probs.some((p) => /when:mode=remote references \{\{mode\}\}/.test(p.message))).toBe(true);
  });

  it('flags a malformed when: with no =', () => {
    const md = ['```nc:prompt mode', 'm', '```', '```nc:env-set when:mode', 'X=1', '```'].join('\n');
    const probs = validate(parseDirectives(md));
    expect(probs.some((p) => /when:mode must be <var>=<value>/.test(p.message))).toBe(true);
  });

  it('registers each capture:<var>=<FIELD> as defined so downstream {{vars}} pass lint', () => {
    const md = [
      '```nc:run effect:step capture:platform_id=PLATFORM_ID,owner_handle=ADMIN_ID',
      'run the step',
      '```',
      '```nc:env-set',
      'P={{platform_id}}',
      'O={{owner_handle}}',
      '```',
    ].join('\n');
    expect(validate(parseDirectives(md))).toEqual([]);
  });

  it('registers each capture:<var>=<dot-path> (JSON multi-field) var as defined for downstream {{vars}}', () => {
    const md = [
      '```nc:run capture:application_id=.id,public_key=.verify_key,owner_handle=.owner.id effect:fetch',
      'curl -sf https://example/app',
      '```',
      '```nc:env-set',
      'APP={{application_id}}',
      'PUB={{public_key}}',
      'OWN={{owner_handle}}',
      '```',
    ].join('\n');
    expect(validate(parseDirectives(md))).toEqual([]);
  });

  it('flags an invalid run capture validate:<re> regex', () => {
    const md = ['```nc:run capture:app_id=.id effect:fetch validate:^[', 'curl x', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /run validate:.*is not a valid regex/.test(p.message))).toBe(true);
  });

  it('accepts a valid run capture validate:<re> regex', () => {
    const md = ['```nc:run capture:app_id=.id effect:fetch validate:^\\d+$', 'curl x', '```'].join('\n');
    expect(validate(parseDirectives(md))).toEqual([]);
  });
});

describe('prompt PromptOpts attrs (flags/min/normalize/error/reuse)', () => {
  it('parses flags/min/normalize/reuse into attrs alongside the var + secret flag', () => {
    const md = [
      '```nc:prompt server_url secret validate:^https?:// flags:i min:8 normalize:rstrip-slash reuse:IMESSAGE_SERVER_URL',
      'URL?',
      '```',
    ].join('\n');
    const [d] = parseDirectives(md);
    expect(promptVar(d)).toBe('server_url'); // the var, not `secret`
    expect(d.attrs.flags).toBe('i');
    expect(d.attrs.min).toBe('8');
    expect(d.attrs.normalize).toBe('rstrip-slash');
    expect(d.attrs.reuse).toBe('IMESSAGE_SERVER_URL');
    expect(validate([d])).toEqual([]); // a well-formed prompt with all attrs lints clean
  });

  it('accepts validate:<re> combined with flags:i (a case-insensitive regex is still valid)', () => {
    const md = ['```nc:prompt u validate:^https?:// flags:i', 'URL?', '```'].join('\n');
    expect(validate(parseDirectives(md))).toEqual([]);
  });

  it('flags a non-numeric min:', () => {
    const md = ['```nc:prompt u min:lots', 'q', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /min:lots must be a non-negative integer/.test(p.message))).toBe(true);
  });

  it('flags an unknown normalize: value', () => {
    const md = ['```nc:prompt u normalize:uppercase', 'q', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /normalize:uppercase must be one of/.test(p.message))).toBe(true);
  });

  it('flags a reuse: that is not a valid ENV_KEY', () => {
    const md = ['```nc:prompt u reuse:not-an-env-key', 'q', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /reuse:not-an-env-key must be a valid ENV_KEY/.test(p.message))).toBe(true);
  });

  it('flags illegal regex flags:', () => {
    const md = ['```nc:prompt u validate:^x flags:zzz', 'q', '```'].join('\n');
    expect(validate(parseDirectives(md)).some((p) => /is not a valid regex/.test(p.message))).toBe(true);
  });
});

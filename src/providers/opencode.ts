/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };

  // OPENCODE_PROVIDER / OPENCODE_MODEL come from one of three sources, in
  // order of precedence:
  //   1. per-group env override (ctx.groupEnv) — operator set via
  //      `ncl groups config env-set OPENCODE_PROVIDER=...`
  //   2. host .env (ctx.hostEnv)
  //   3. the group's `model` field (containerConfig.model), which is
  //      stored as the full opencode model reference `<provider>/<model>`
  //      (e.g. `opencode-go/minimax-m3`). Pass the full string through
  //      as-is — the opencode CLI splits it internally and matches the
  //      `enabled_providers` list. Splitting it on `/` here would lose
  //      the provider prefix that opencode needs for the lookup. Without
  //      (3), empty host env means no provider/model is sent and opencode
  //      returns "Model not found" at every turn.
  const providerFromGroup = ctx.groupEnv.OPENCODE_PROVIDER ?? ctx.hostEnv.OPENCODE_PROVIDER;
  const modelFromGroup = ctx.groupEnv.OPENCODE_MODEL ?? ctx.hostEnv.OPENCODE_MODEL;
  if (providerFromGroup) env.OPENCODE_PROVIDER = providerFromGroup;
  if (modelFromGroup) env.OPENCODE_MODEL = modelFromGroup;
  if (!providerFromGroup || !modelFromGroup) {
    const groupModel = ctx.containerConfig?.model;
    if (groupModel) {
      if (groupModel.includes('/')) {
        const [prov] = groupModel.split('/', 2);
        if (!providerFromGroup && prov) env.OPENCODE_PROVIDER = prov;
      }
      if (!modelFromGroup) env.OPENCODE_MODEL = groupModel;
    }
  }

  for (const key of [
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_API_KEY',
    'OPENCODE_REASONING_EFFORT',
    'OPENROUTER_PROVIDERS',
    'OPENCODE_IDLE_TIMEOUT_MS',
  ] as const) {
    const fromGroup = ctx.groupEnv[key];
    const value = fromGroup ?? ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  // Per-group opt-in for opencode npm plugins (e.g. `opencode-claude-memory`
  // for shared persistent memory). The host passes this through the group's
  // `env` map (set via `ncl groups config env-set`). Empty by default so
  // groups without a memory plugin don't pay the cost.
  const plugins = ctx.groupEnv.NANOCLAW_OPENCODE_PLUGINS ?? ctx.hostEnv.NANOCLAW_OPENCODE_PLUGINS;
  if (plugins) env.NANOCLAW_OPENCODE_PLUGINS = plugins;

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});

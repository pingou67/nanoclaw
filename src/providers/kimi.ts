/**
 * Host-side container config for the `kimi` provider (Kimi Code CLI).
 *
 * Kimi Code is a ~160 MB binary the operator installs and authenticates on the
 * HOST (`kimi login`, device-code OAuth). We mount that binary read-only into
 * each container instead of baking a copy into the image — the same trade-off
 * as the rtk mount, and it keeps every container on whatever version the
 * operator last installed.
 *
 * Only one of the four mounts is read-only-by-choice; the other two writable
 * ones are load-bearing:
 *
 *  - `<sessionDir>/kimi-home` → /kimi-home is KIMI_CODE_HOME. The
 *    container-side provider stages config.toml / mcp.json / AGENTS.md there,
 *    and kimi writes its session transcripts and logs into it. Per session, so
 *    two groups never share session state.
 *  - the host credentials dir → /kimi-home/credentials, READ-WRITE. Kimi's
 *    OAuth access token lives 900 seconds and is renewed against a rotating
 *    refresh token; a read-only mount would authenticate for one turn and then
 *    fail permanently. Mounting the host directory keeps a single source of
 *    truth, and kimi serializes concurrent refreshes with its own OAuth lock
 *    (only disabled by KIMI_DISABLE_OAUTH_LOCK, which we never set).
 *
 * The operator's config.toml is mounted read-only under a distinct path rather
 * than copied into the session home: the container provider overlays the
 * group's model/effort onto it and writes the result as the real config, so
 * the operator's provider block (OAuth storage key, base_url, model catalog)
 * stays the single upstream definition.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig, type VolumeMount } from './provider-container-registry.js';

/** Where Kimi Code keeps its install on the host. */
export function hostKimiHome(hostEnv: NodeJS.ProcessEnv): string {
  return hostEnv.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

/**
 * Docker `-e` args that blank out the OneCLI proxy, for providers that
 * authenticate with their OWN mounted credentials. `container-runner.ts` pushes
 * these after the gateway apply, so the later `-e` wins.
 *
 * kimi is such a provider — its OAuth file is mounted below — so the gateway
 * has no upstream key to inject and the proxy is pure overhead. Leaving it set
 * is actively harmful: kimi's HTTP client is undici, and OneCLI also exports
 * NODE_USE_ENV_PROXY=1, so every request is routed through the gateway,
 * including the ones a remote MCP server on the LAN needs. Those come back as
 * ERR_HPE_INVALID_CONSTANT and kimi drops the server SILENTLY — its tools
 * simply never appear, which reads as a broken server rather than a proxied one.
 *
 * BOTH pairs must be cleared. The claude path clears only the uppercase one,
 * which is enough for the Anthropic SDK; undici reads the LOWERCASE
 * `http_proxy` / `https_proxy` too, and those are the ones OneCLI sets with
 * credentials. Clearing only the uppercase pair looks like a fix and changes
 * nothing — verified in-container: `HTTP_PROXY=<empty>` while `http_proxy` was
 * still live, and the remote MCP server stayed invisible. curl hides the
 * problem entirely (it ignores uppercase HTTP_PROXY by design), so a manual
 * Bash fallback succeeds while the MCP transport fails.
 *
 * Returns [] for every other provider: opencode and agy need the gateway to
 * inject their upstream key, and clearing it there strips the auth header.
 */
export function proxyClearingArgs(provider: string): string[] {
  if (provider !== 'kimi') return [];
  return ['-e', 'HTTPS_PROXY=', '-e', 'HTTP_PROXY=', '-e', 'https_proxy=', '-e', 'http_proxy='];
}

registerProviderContainerConfig('kimi', (ctx) => {
  const kimiHome = hostKimiHome(ctx.hostEnv);
  const sessionHome = path.join(ctx.sessionDir, 'kimi-home');
  fs.mkdirSync(sessionHome, { recursive: true });

  const mounts: VolumeMount[] = [{ hostPath: sessionHome, containerPath: '/kimi-home', readonly: false }];

  // Each optional mount is added only when the host path exists, so a partial
  // install surfaces as a legible "kimi: … not found" line at spawn instead of
  // an opaque ENOENT or an empty-directory mount inside the container.
  const binary = path.join(kimiHome, 'bin', 'kimi');
  if (fs.existsSync(binary)) {
    mounts.push({ hostPath: binary, containerPath: '/usr/local/bin/kimi', readonly: true });
  } else {
    console.warn(`kimi provider: binary not found at ${binary} — containers will fail to spawn the CLI`);
  }

  const credentials = path.join(kimiHome, 'credentials');
  if (fs.existsSync(credentials)) {
    // Read-write on purpose — see the file header (900s token, rotating refresh).
    mounts.push({ hostPath: credentials, containerPath: '/kimi-home/credentials', readonly: false });
  } else {
    console.warn(`kimi provider: no credentials at ${credentials} — run \`kimi login\` on the host`);
  }

  const baseConfig = path.join(kimiHome, 'config.toml');
  if (fs.existsSync(baseConfig)) {
    mounts.push({ hostPath: baseConfig, containerPath: '/kimi-base-config.toml', readonly: true });
  }

  return {
    mounts,
    env: {
      KIMI_CODE_HOME: '/kimi-home',
      // The binary is a read-only mount and every session gets a fresh home;
      // a self-update would either fail on the mount or silently drift one
      // container's version away from the operator's install.
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_DISABLE_TELEMETRY: '1',
      // kimi's default MCP budget is tuned for a warm developer machine; a
      // fresh container is neither — the `npx -y …` stdio servers download
      // their package on first start. Raised as headroom, not as a fix for
      // anything observed: a server that misses the budget is dropped
      // SILENTLY, so the failure mode is indistinguishable from a broken
      // server and is not worth re-diagnosing per group. Overridable per
      // group for a server that is slower still.
      KIMI_MCP_STARTUP_TIMEOUT_MS: ctx.groupEnv.KIMI_MCP_STARTUP_TIMEOUT_MS ?? '120000',
      KIMI_MCP_TOOL_TIMEOUT_MS: ctx.groupEnv.KIMI_MCP_TOOL_TIMEOUT_MS ?? '180000',
    },
  };
});

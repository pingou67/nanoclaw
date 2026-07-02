/**
 * Host-side container config for the `agy` provider (Google Antigravity / Gemini).
 *
 * Unlike opencode (an npm SDK baked into the image), the Antigravity CLI is a
 * single host binary at `~/.local/bin/agy` plus a data dir `~/.gemini`
 * (OAuth token + per-conversation brain/transcripts). Both are mounted into the
 * container at spawn — the binary read-only at /usr/local/bin/agy (on PATH),
 * the data dir read-write at /home/node/.gemini so the agy CLI can read the
 * OAuth token and persist its conversation state. The container already runs as
 * the host uid (container-runner adds `--user`), so the 0600 token is readable.
 *
 * No Dockerfile/image changes are needed: the binary is mounted, not installed,
 * and the provider source ships in the bind-mounted agent-runner tree.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('agy', (ctx) => {
  const home = ctx.hostEnv.HOME || `/home/${ctx.hostEnv.USER || 'node'}`;
  const agyBinary = path.join(home, '.local', 'bin', 'agy');
  const geminiDir = path.join(home, '.gemini');

  const mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
  if (fs.existsSync(agyBinary)) {
    mounts.push({ hostPath: agyBinary, containerPath: '/usr/local/bin/agy', readonly: true });
  }
  if (fs.existsSync(geminiDir)) {
    mounts.push({ hostPath: geminiDir, containerPath: '/home/node/.gemini', readonly: false });
  }

  // HOME so the agy CLI resolves ~/.gemini to the mounted data dir.
  return { mounts, env: { HOME: '/home/node' } };
});

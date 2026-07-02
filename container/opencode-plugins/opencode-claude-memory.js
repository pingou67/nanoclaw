/**
 * opencode-claude-memory — local-load shim.
 *
 * The package is pre-installed in the agent image (pnpm global, pinned in
 * container/cli-tools.json), but opencode's npm-install path for config
 * `plugin` entries crashes when HTTP_PROXY/HTTPS_PROXY are set (OneCLI
 * gateway): upstream bug in @npmcli/agent under Bun — anomalyco/opencode
 * #21327 / #21468 / #22454. This shim loads the packaged copy directly as a
 * global-dir plugin file (no npm install involved).
 *
 * Self-gating: only activates when the group opted in via
 * NANOCLAW_OPENCODE_PLUGINS (same env the agent-runner reads), so mounting
 * this shared dir into every opencode group stays a no-op for the others.
 * The agent-runner drops shimmed names from config.plugin — see
 * buildOpenCodeConfig in container/agent-runner/src/providers/opencode.ts.
 */
import fs from 'node:fs';

function findPackagedEntry() {
  const base = '/pnpm/global';
  try {
    for (const version of fs.readdirSync(base)) {
      const p = `${base}/${version}/node_modules/opencode-claude-memory/dist/index.js`;
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* /pnpm/global absent — not this image */
  }
  return null;
}

export const MemoryPlugin = async (ctx) => {
  try {
    const optIn = JSON.parse(process.env.NANOCLAW_OPENCODE_PLUGINS ?? '[]');
    if (!Array.isArray(optIn) || !optIn.includes('opencode-claude-memory')) return {};
    const entry = findPackagedEntry();
    if (!entry) {
      console.error('[claude-memory shim] opencode-claude-memory introuvable sous /pnpm/global');
      return {};
    }
    const mod = await import(entry);
    return await mod.MemoryPlugin(ctx);
  } catch (e) {
    console.error('[claude-memory shim] chargement échoué:', e?.message ?? e);
    return {};
  }
};

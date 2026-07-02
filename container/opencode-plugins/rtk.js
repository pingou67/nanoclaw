/**
 * rtk token-compression proxy — opencode plugin.
 *
 * Rewrites bash tool commands through rtk's hook engine (same rewrite rules as
 * Claude Code's PreToolUse hook: `git status` → `rtk git status`, 60–90% token
 * savings on supported dev commands). No-op if rtk is absent or the command
 * isn't supported.
 *
 * Mounted RO at /home/node/.config/opencode/plugin by the host opencode provider
 * contribution (src/providers/opencode.ts). The rtk binary is mounted RO
 * at /usr/local/bin/rtk from the host's ~/.local/bin/rtk.
 */
export const RtkPlugin = async ({ $ }) => {
  return {
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'bash') return;
      const cmd = output?.args?.command;
      if (!cmd || typeof cmd !== 'string' || cmd.startsWith('rtk ')) return;
      try {
        const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } });
        const res = await $`echo ${payload} | rtk hook claude`.quiet().nothrow();
        if (res.exitCode !== 0) return;
        const out = res.stdout.toString().trim();
        if (!out) return;
        const updated = JSON.parse(out)?.hookSpecificOutput?.updatedInput?.command;
        if (updated && typeof updated === 'string') output.args.command = updated;
      } catch {
        // rtk missing or malformed output — run the original command untouched.
      }
    },
  };
};

---
name: add-rtk
description: Install rtk token-compression proxy into agent containers. Routes Bash tool calls through rtk for 60–90% token savings on dev commands (git, cargo, pytest, docker, kubectl, etc.). Works for all providers (claude hook, opencode plugin, agy/codex instructions).
---

# Add rtk

Install [rtk](https://github.com/rtk-ai/rtk) — a CLI proxy delivering 60–90% token savings on common dev commands (git, cargo, pytest, docker, kubectl, etc.) — and wire it transparently into every agent container, whatever the provider.

> **Note (2026-07-02)** — This install already has rtk fully wired (all providers + auto-update timer). This skill documents the architecture; re-run individual steps only to repair or extend.

## Architecture

- **Binary**: the official **musl static build** from GitHub releases lives at `~/.local/bin/rtk`. Do NOT copy a brew/linuxbrew binary there — it links against `/home/linuxbrew/...` libs that don't exist in the container image.
- **Mount**: `src/container-runner.ts` mounts `~/.local/bin/rtk` RO at `/usr/local/bin/rtk` in EVERY container when the host file exists (global, provider-agnostic — same pattern as the OAuth credential mount). Do not use `additional_mounts` for this: `validateAdditionalMounts` rejects absolute containerPaths (everything lands under `/workspace/extra/`, off the PATH).
- **Per-provider wiring**:
  - **claude** — `PreToolUse` hook (`rtk hook claude`, matcher `Bash`) in each group's `data/v2-sessions/<gid>/.claude-shared/settings.json`. Merged, never clobbering existing hooks (PreCompact etc.).
  - **opencode** — shared plugin `container/opencode-plugins/rtk.js`, mounted RO at `/home/node/.config/opencode/plugin` (opencode's global plugin dir) by the host provider contribution in `src/providers/opencode.ts` (shipped by `/add-opencode` — required for this leg). The plugin shells the command through `rtk hook claude` and rewrites `output.args.command`. Note: rtk's stats land under `XDG_DATA_HOME=/opencode-xdg/rtk/` in these containers. The plugin's canonical payload is `resources/rtk.js` in this skill dir; install/repair with:

    ```bash
    mkdir -p container/opencode-plugins
    cp .claude/skills/add-rtk/resources/rtk.js container/opencode-plugins/rtk.js
    ```

    After editing the installed copy, mirror it back with `pnpm exec tsx scripts/skills-sync.ts sync add-rtk` (`pnpm test` fails on drift — manifest: `skill-sync.json`).
  - **agy / codex** — rules file (prompt-level), rtk's official tier for these agents (see [supported-agents.md](https://github.com/rtk-ai/rtk/blob/master/docs/guide/getting-started/supported-agents.md)). For agy: `rtk init --agent antigravity` generates `.agents/rules/antigravity-rtk-rules.md`; install it into the group workspace at `groups/<folder>/.agents/rules/`. Antigravity reads `.agents/rules/` as custom instructions. NOT transparent — relies on the model following the rule. Transparent rewriting is blocked upstream: Antigravity's PreToolUse hook is decision-only (agy ignores the `overwrite` field of PreToolHookResult — see rtk-ai/rtk#2093 and the Google bug report linked there). If both get fixed, switch to `rtk hook antigravity`.
- **Updates**: systemd user timer `nanoclaw-rtk-update.timer` (daily 09:15) runs `~/.nanoclaw-rtk-update/check.sh`: compares installed version to the latest GitHub release, downloads the musl build, verifies sha256 against `checksums.txt`, replaces the binary atomically, and notifies the Mattermost DM (reuses `~/.nanoclaw-upstream-watch/post.js`). Running containers keep the old inode; every new spawn gets the new version. `FORCE=1` to test a full cycle.

## Verify

```bash
# Binary + hook inside a running container
docker exec <container> rtk --version
docker exec <container> sh -c 'echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git log\"}}" | rtk hook claude'

# Claude group: hook present?
jq '.hooks.PreToolUse' data/v2-sessions/<gid>/.claude-shared/settings.json

# OpenCode: plugin loaded? (look for "loading plugin ... rtk.js")
grep -i plugin data/v2-sessions/<gid>/<sid>/opencode-xdg/opencode/log/*.log

# Update timer
systemctl --user list-timers nanoclaw-rtk-update.timer
tail ~/.nanoclaw-rtk-update/update.log
```

## Troubleshooting

- **`rtk: command not found` in container** — `~/.local/bin/rtk` missing on host, or host not restarted since the container-runner patch. Check `docker inspect <container>` for the `/usr/local/bin/rtk` mount.
- **Binary won't run in container (`no such file or directory` on exec)** — wrong build (brew/glibc-linuxbrew). Reinstall the `rtk-x86_64-unknown-linux-musl.tar.gz` release build to `~/.local/bin/rtk`.
- **Claude hook not firing** — re-add the PreToolUse entry to the group's settings.json (see Verify) and respawn the container.
- **OpenCode commands not rewritten** — check the opencode log for plugin load errors; the plugin fails open (original command runs untouched).

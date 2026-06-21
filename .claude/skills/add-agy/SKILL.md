---
name: add-agy
description: Use Google Antigravity (Gemini) as an agent provider. A group runs on Gemini via the Antigravity CLI instead of the Claude Agent SDK — same poll-loop, container infra, MCP, live-status, background. Per-group via `ncl groups config update --provider agy`. Needs the `agy` CLI + a Google OAuth login on the host.
---

# Agy agent provider (Google Antigravity / Gemini)

NanoClaw runs agents in a long-lived **poll loop** inside the container. The
backend is selected per-group with **`provider`** (`claude` | `opencode` |
`agy` | `mock`). The `agy` provider drives Google's **Antigravity CLI**
(`agy`), so a group answers with **Gemini** models at parity with the Claude
Code containers — same container, MCP isolation, live-status, background, ncl.

Unlike opencode (an npm SDK baked into the image), the Antigravity CLI is a
**single host binary** plus a host OAuth login. The provider mounts both into
the container at spawn — **no image rebuild needed**, the provider source ships
in the bind-mounted agent-runner tree.

## Install

### Pre-flight

The provider source ships in trunk. If all of the following are present, skip
to **Host auth**:

- `src/providers/agy.ts`
- `container/agent-runner/src/providers/agy.ts`
- `import './agy.js';` in `src/providers/index.ts` and `container/agent-runner/src/providers/index.ts`
- `src/providers/agy-registration.test.ts` + the two container test guards

Missing — copy them in from this repo's history (`git show <ref>:<path>`) and
re-append the barrel import lines (idempotent).

### Host auth (the non-trivial part)

The `agy` provider authenticates with **one Google account per host**, via the
Antigravity CLI's own OAuth — **not** OneCLI, not an env var. Two artifacts must
exist on the host that runs agy groups:

1. **The CLI binary** at `~/.local/bin/agy` (~170 MB). Install/update it with
   the official Antigravity installer, or `agy update` if already present.
2. **An OAuth login** at `~/.gemini/antigravity-cli/antigravity-oauth-token`.
   Produce it by running the CLI once interactively and completing the Google
   sign-in:

   ```bash
   ~/.local/bin/agy --prompt "hello"
   # → prints a Google OAuth URL; open it, authorize, paste the code back.
   # On success the token file appears under ~/.gemini/antigravity-cli/.
   ```

   Verify: `ls -l ~/.gemini/antigravity-cli/antigravity-oauth-token` (mode 0600).

The host-side contribution (`src/providers/agy.ts`) mounts `~/.local/bin/agy`
read-only at `/usr/local/bin/agy` and `~/.gemini` read-write at
`/home/node/.gemini`, with `HOME=/home/node`. The container runs as the host
uid (container-runner adds `--user`), so the 0600 token is readable inside.

> **Moving a host's agy auth elsewhere**: copy `~/.local/bin/agy` and
> `~/.gemini/` to the new host (same Google account). Stop any other process
> using that login first — a token shared by two live hosts can clash.

## Configuration

Point a group at Gemini (takes effect on next `ncl groups restart` / next turn):

```bash
ncl groups config update --id <agent-group-id> --provider agy
# optional: pin a Gemini model — see `agy models` for the list
ncl groups config update --id <agent-group-id> --model <gemini-model>
```

No `--rebuild` needed (binary is mounted, not installed). A group with no
`--model` uses the Antigravity CLI default.

## Validate

```bash
# 1. typecheck + tests (the registration guards go red if a barrel drifts)
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test                          # host — includes agy host-registration
# container tests (bun) — include agy.factory + agy-registration:
docker run --rm --entrypoint sh -v "$PWD/container/agent-runner:/ar" -w /ar \
  <agent-image>:latest -c 'bun test'

# 2. the CLI actually authenticates in the container (replace the image tag):
docker run --rm --entrypoint sh --user "$(id -u):$(id -g)" -e HOME=/home/node \
  -v ~/.local/bin/agy:/usr/local/bin/agy:ro -v ~/.gemini:/home/node/.gemini \
  <agent-image>:latest \
  -c 'agy --print --dangerously-skip-permissions --prompt "Reply only: OK"'
# → prints OK. If it prints a Google OAuth URL instead, the host login is
#   missing or the uid can't read the token (see Host auth).
```

## Notes

- **No Dockerfile change**: the binary is mounted, so the agent image is
  unchanged. Only a host with the `agy` binary + OAuth login can run agy
  groups; other hosts keep using claude/opencode.
- The provider yields `progress` events from the CLI's `transcript.jsonl`
  (`PLANNER_RESPONSE` content + tool_calls), so **live-status works** the same
  as Claude/OpenCode.
- **MCP servers**: Antigravity does *not* read a raw `mcp.json` — it loads MCP
  servers from imported **plugins**. The provider materializes a group's
  `mcp_servers` as a Gemini-CLI extension under
  `$HOME/.gemini/extensions/nanoclaw-mcp/gemini-extension.json`, then runs
  `agy plugin import gemini` to stage them. Set MCP servers the usual way
  (`ncl groups config add-mcp-server …`); nanoclaw-only keys like `instructions`
  are stripped (the extension schema is command/args/env only). **Isolation**:
  `~/.gemini` is a shared host mount, so to keep each agy group's MCP servers
  separate the provider runs agy under a per-container fake `HOME`
  (`/tmp/agy-mcp-home`) whose `.gemini` symlinks the real one EXCEPT
  `config/`+`extensions/` (kept container-local). Multiple Gemini groups can run
  with different MCP servers without sharing them.
- Memory: agy keeps its own per-conversation brain under
  `~/.gemini/antigravity-cli/brain/<session>` (mounted), so continuations
  resume across turns.

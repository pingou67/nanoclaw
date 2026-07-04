---
name: add-opencode-memory
description: Add persistent Claude Code-compatible memory to agent groups — opencode groups via the opencode-claude-memory plugin (local shim, no runtime npm install, works behind the OneCLI proxy; requires /add-opencode), other providers (agy, claude) via a bundled stdio MCP server exposing the same memory_* tools on the same Markdown store.
---

# Add opencode-claude-memory

Gives OpenCode-backed groups the `memory_*` tools (persistent, local-first Markdown memory, Claude Code-compatible layout). The npm package is baked into the agent image; at runtime a **local shim** loads it as an opencode global-dir plugin file. The shim exists because opencode's own `config.plugin` path npm-installs plugins at every boot, which crashes when `HTTP_PROXY`/`HTTPS_PROXY` are set (OneCLI gateway) — upstream bug in `@npmcli/agent` under Bun (anomalyco/opencode#21327/#21468/#22454). If upstream fixes it, the shim can be retired and `NANOCLAW_OPENCODE_PLUGINS` alone will suffice.

**Requires `/add-opencode`**: the shim is mounted through the shared plugin dir (`container/opencode-plugins` → `/home/node/.config/opencode/plugin`) that the opencode host contribution declares, and the shim-aware `config.plugin` filter lives in the opencode container provider.

## Install

### Pre-flight (idempotent)

Skip to **Enable per group** if all of these are in place:

- `container/opencode-plugins/opencode-claude-memory.js` exists
- `container/cli-tools.json` has an `opencode-claude-memory` entry
- `/add-opencode` is installed (`src/providers/opencode.ts` exists)

### 1. Copy the shim

```bash
mkdir -p container/opencode-plugins
cp .claude/skills/add-opencode-memory/resources/opencode-claude-memory.js container/opencode-plugins/
```

The shim self-gates on `NANOCLAW_OPENCODE_PLUGINS`: mounted into every opencode group, it stays a no-op for groups that didn't opt in.

### 2. Bake the package into the agent image (pinned)

Add to `container/cli-tools.json` (skip if present):

```json
{ "name": "opencode-claude-memory", "version": "1.7.2" }
```

Then rebuild the image and restart:

```bash
./container/build.sh
# Linux: systemctl --user restart nanoclaw
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 3. Enable per group

```bash
ncl groups config env-set --id <agent-group-id> --key NANOCLAW_OPENCODE_PLUGINS --value '["opencode-claude-memory"]'
ncl groups restart --id <agent-group-id>
```

## Validate

`pnpm test` includes `container/agent-runner/src/providers/opencode.plugins.test.ts` (bun side: the shim filter) and `scripts/skills-sync.test.ts` (shim payload in sync + cli-tools entry present). End-to-end: ask the group's agent to call `memory_list` — it should answer (empty store on first run), and the opencode log (`data/v2-sessions/<gid>/<sid>/opencode-xdg/opencode/log/`) shows `loading plugin path=file:///home/node/.config/opencode/plugin/opencode-claude-memory.js` with no npm-install error.

Memories persist on the host under `data/v2-sessions/<gid>/.claude-shared/projects/-workspace-group/memory/` — they survive container respawns and are Claude Code-format compatible (useful for provider switches, see `/migrate-memory`).

## Variant for non-opencode providers (agy, claude) — MCP server

The opencode plugin mechanism only exists for the opencode provider. For any
other provider, the same memory store is exposed through a bundled **stdio MCP
server** (`memory_index/list/read/search/save/delete` tools, same file format,
same limits — a group can even switch providers and keep its memories).

### Install

```bash
mkdir -p container/agent-runner/src/mcp-servers/memory
cp .claude/skills/add-opencode-memory/resources/memory-mcp-server.ts \
   container/agent-runner/src/mcp-servers/memory/server.ts
```

No rebuild: the server runs with bun from the bind-mounted agent-runner tree
and resolves `@modelcontextprotocol/sdk` + `zod` from `/app/node_modules`
(both are existing agent-runner deps).

### Enable per group

Add the MCP entry (via `ncl groups config add-mcp-server` or SQL `json_patch`):

```json
{"memory": {"command": "bun", "args": ["run", "/app/src/mcp-servers/memory/server.ts"],
 "env": {"MEMORY_DIR": "/home/node/.claude/projects/-workspace-group/memory"}}}
```

`MEMORY_DIR` points into the group's `.claude-shared` mount — the exact
directory the opencode plugin uses, so both variants share one store. Then
`ncl groups restart --id <gid>`.

**agy caveat**: Antigravity strips the nanoclaw-only `instructions` key from
extensions, so tell the agent about the tools in the group's `CLAUDE.local.md`
(consult `memory_index` at conversation start, save durable facts with
`memory_save`).

### Validate

Ask the group's agent to call `memory_index` (empty store on first run), then
to save + re-read a note. Files land on the host under
`data/v2-sessions/<gid>/.claude-shared/projects/-workspace-group/memory/`.

## Maintenance (fork model)

Canonical payloads: `resources/opencode-claude-memory.js` (mirror of
`container/opencode-plugins/opencode-claude-memory.js`) and
`resources/memory-mcp-server.ts` (mirror of
`container/agent-runner/src/mcp-servers/memory/server.ts`), refreshed with
`pnpm exec tsx scripts/skills-sync.ts sync add-opencode-memory`. Manifest:
`skill-sync.json`.

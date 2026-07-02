---
name: add-vikunja
description: Add a Vikunja (task management) MCP server to agent groups — list/search/create/update/complete tasks against a Vikunja instance, with optional per-group project scoping. Stdio MCP server run with bun from the mounted agent-runner tree; works with any provider (claude, opencode, agy).
---

# Add Vikunja MCP server

An in-repo stdio MCP server for [Vikunja](https://vikunja.io) task management. It runs with `bun` from the bind-mounted agent-runner tree (`/app/src/mcp-servers/vikunja/server.ts`) and resolves the MCP SDK from `/app/node_modules` — no image rebuild, no extra dependency, provider-agnostic.

Features: task list/search/create/update/complete, project resolution by **name or id**, per-group **project scoping** (`VIKUNJA_PROJECT_SCOPE`) so e.g. a family group only sees the `FAMILLE` project, and a `bulk_update_tasks` that goes through the same field allowlist as single updates.

## Install

### Pre-flight (idempotent)

Skip to **Wire into a group** if `container/agent-runner/src/mcp-servers/vikunja/server.ts` exists.

### 1. Copy the server files

```bash
mkdir -p container/agent-runner/src/mcp-servers/vikunja
cp .claude/skills/add-vikunja/resources/server.ts    container/agent-runner/src/mcp-servers/vikunja/server.ts
cp .claude/skills/add-vikunja/resources/test-live.ts container/agent-runner/src/mcp-servers/vikunja/test-live.ts
cp .claude/skills/add-vikunja/resources/mcp-servers-README.md container/agent-runner/src/mcp-servers/README.md
```

No barrel, no dependency: MCP servers are wired per group through the container config (below), and the MCP SDK + zod already ship in the agent-runner tree.

### 2. Validate

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

## Credentials

Store the Vikunja API token in the OneCLI vault (never in the repo or chat):

```bash
onecli secrets create --name "Vikunja" --type generic \
  --value <token> --host-pattern "<your-vikunja-host>" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

If you prefer per-group env instead (self-hosted, low-risk setups), pass `VIKUNJA_TOKEN` via the group env in step 3 — the value then lives in the central DB.

## Wire into a group

```bash
ncl groups config add-mcp-server --id <agent-group-id> --name vikunja \
  --command bun --args '["/app/src/mcp-servers/vikunja/server.ts"]' \
  --env '{"VIKUNJA_URL":"https://vikunja.example.com","VIKUNJA_TOKEN":"<token>","VIKUNJA_DEFAULT_PROJECT_ID":"FAMILLE","VIKUNJA_PROJECT_SCOPE":"FAMILLE"}'
ncl groups restart --id <agent-group-id>
```

Env knobs (see the server header for details): `VIKUNJA_URL` + `VIKUNJA_TOKEN` (required), `VIKUNJA_DEFAULT_PROJECT_ID` (name or id, default Inbox), `VIKUNJA_PROJECT_SCOPE` (empty/`ALL`, one, or CSV of projects — hard fence, tasks outside the scope are invisible).

Smoke test: ask the group's agent to list your Vikunja tasks. For a host-side live check against the real API: `bun container/agent-runner/src/mcp-servers/vikunja/test-live.ts` (inside the container, or any bun with the env set).

## Note on testing

The only functional integration is the runtime `add-mcp-server` wiring through `ncl` — it has no in-tree source footprint, so no registration test applies (see skill-guidelines, "When there is genuinely nothing to test in-tree"). Conformance is anatomy + the container typecheck; `scripts/skills-sync.test.ts` guards the payload mirror.

## Maintenance (fork model)

Canonical payload: `resources/` here, mirrored from the installed copies with `pnpm exec tsx scripts/skills-sync.ts sync add-vikunja`. Manifest: `skill-sync.json`.

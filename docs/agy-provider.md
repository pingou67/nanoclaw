# Provider `agy` (Google Antigravity / Gemini)

`agy` is NanoClaw's third agent provider (after `claude` and `opencode`). A group
with `provider=agy` answers with **Google Gemini** models, driven by Google's
**Antigravity CLI** (`agy`) instead of the Claude Agent SDK — at parity with the
Claude Code containers: same poll-loop, container infra, MCP, live-status,
background, `ncl`.

Install/auth is covered by the `/add-agy` skill. This doc explains how the
provider works internally — in particular the **MCP mechanism** and its
**per-container isolation**, which differ from the other providers.

## Key files

| File | Role |
|------|------|
| `container/agent-runner/src/providers/agy.ts` | The CLI wrapper (spawns `agy --print`, tails `transcript.jsonl`, emits provider events, wires MCP). |
| `src/providers/agy.ts` | Host contribution: `registerProviderContainerConfig('agy', …)` — mounts the binary + data dir. |

No Dockerfile/image change: the binary is **mounted**, not installed, and the
provider source ships in the bind-mounted agent-runner tree.

## Host auth (one Google account per host)

The provider authenticates with the Antigravity CLI's own OAuth — **not** OneCLI,
not an env var. Two host artifacts:

- `~/.local/bin/agy` — the CLI binary (~170 MB), mounted **read-only** at
  `/usr/local/bin/agy` (on PATH).
- `~/.gemini/` — data dir holding the OAuth token
  (`antigravity-cli/antigravity-oauth-token`, mode 0600) plus per-conversation
  state (`antigravity-cli/conversations/`, `antigravity-cli/brain/`). Mounted
  **read-write** at `/home/node/.gemini`, with `HOME=/home/node` so the CLI
  resolves `~/.gemini` to the mount.

The container runs as the host uid (`--user`), so the 0600 token is readable.

## Lifecycle

`query()` spawns `agy --print --conversation <id> [--model X] [--effort Y]`,
streams stdout, and tails the conversation's `transcript.jsonl` for live progress:

- **Continuations**: the conversation id is persisted as the session's
  `continuation`; the brain/conversations dirs (mounted) let Gemini resume across
  turns.
- **Live-status**: each `PLANNER_RESPONSE` `tool_calls` entry is routed through
  the shared `summarizeToolUse` helper (`providers/summarize.ts`), so the
  one-liner looks identical to the claude/opencode providers
  (`🔧 list_dir(DirectoryPath=…)`). `transcript.jsonl` is **cumulative per
  conversation**, so each turn starts tailing from the file's current **end** —
  otherwise a continuation would replay every prior turn's tool_calls as
  live-status and could surface a stale `PLANNER_RESPONSE` as its result.
- **Compaction**: Antigravity auto-compacts internally (opaque, not
  configurable). The provider implements none of the optional compaction hooks
  (`maybeRotateContinuation`, pre-compact archive) — see the design notes if a
  Claude-Code-style control is ever wanted.

## MCP servers — the plugin mechanism

**Antigravity does NOT read a raw `mcp.json`.** It loads MCP servers from
imported **plugins**. The working flow the provider performs when a group has
`mcp_servers` configured:

1. Materialize the configured servers as a **Gemini-CLI extension**:
   `<HOME>/.gemini/extensions/nanoclaw-mcp/gemini-extension.json` with a
   `mcpServers` key. nanoclaw-only keys (e.g. `instructions`) are stripped — the
   extension schema only knows `command`/`args`/`env`.
2. Run `agy plugin import gemini`, which stages the servers into
   `<HOME>/.gemini/config/` where the CLI actually reads them at spawn.

Set MCP servers the usual way — `ncl groups config add-mcp-server …`. Useful
probes on the host: `agy plugin list`, `agy plugin import gemini`,
`agy plugin uninstall <name>`.

> ⚠️ **Verifying MCP works**: an agent can *describe* a tool it doesn't actually
> have. Always test by calling a tool whose output is verifiable
> (`echo` → `Echo: <msg>`, or `imap_list_folders` → real folders), never by
> asking "do you have tool X".

> ⚠️ **Reserved server names**: Antigravity silently skips an MCP server named
> `gmail` — the import succeeds, no error is logged, but the server is never
> launched (no `<HOME>/.gemini/antigravity-cli/mcp/gmail/` schema-cache dir
> appears) and its tools never reach the model. Presumably a collision with
> Antigravity's built-in Google integrations. Rename the key (e.g.
> `gmail-perso`) and it works. Observed on agy 2026-07; if a server's tools
> are mysteriously absent, check the `mcp/<name>/` cache dir and try renaming.

## Per-container MCP isolation

`~/.gemini` is a **shared host mount** — every agy group's container mounts the
same host directory. If the MCP config were staged into the shared
`~/.gemini/config`, **all agy groups would share the same MCP servers**
(e.g. one group's IMAP would leak to every Gemini group). That is unacceptable
as soon as there is more than one Gemini group.

So the provider stages MCP config into a **container-local fake `HOME`**
(`/tmp/agy-mcp-home`). Because each agy group runs in its own Docker container,
`/tmp` is naturally isolated per container. The fake `.gemini`:

- **symlinks** the real `~/.gemini` contents (OAuth token, `conversations/`,
  `brain/`, `settings.json`) — so auth and continuations stay shared/working;
- keeps **`config/` and `extensions/` container-local** — so the imported MCP
  servers live only in that container.

`agy plugin import gemini` and the `agy --print` spawn both run with
`HOME=/tmp/agy-mcp-home`. The import runs once per container (guarded by the
`mcpReady` flag on the provider instance). Groups **without** MCP keep using the
real `HOME`, reading the (MCP-free) shared `~/.gemini/config`.

**Result**: multiple Gemini groups can run with different MCP servers without
sharing them. Verified with two containers mounting the same `~/.gemini`: the
one with IMAP sees its folders, the other reports no IMAP tool, and the shared
`~/.gemini/config` stays empty (no leak).

## Memory portability across providers

The shared, provider-agnostic memory file is `/workspace/agent/CLAUDE.local.md`
(host: `groups/<folder>/CLAUDE.local.md`). **claude** auto-loads it from the cwd
(and the composed `CLAUDE.md` references it); **opencode** points at it
explicitly (`providers/opencode.ts`). So a group switched between claude and
opencode keeps its memory.

Antigravity, however, persists learned facts to its **own** native file
`<cwd>/.agents/AGENTS.md`. Left alone, an agy group's memory would be invisible
to claude/opencode after a provider switch (and vice versa).

Fix (in `providers/agy.ts`, `ensureMemoryLink`): on first turn the provider makes
`.agents/AGENTS.md` a **symlink to `CLAUDE.local.md`**. Antigravity edits
AGENTS.md in place (verified: the symlink survives writes), so agy reads/writes
the same shared file. Any pre-existing `AGENTS.md` content is folded into
`CLAUDE.local.md` once before linking. Net result: **memory is portable across
all three providers** — switch a group's `provider` and its accumulated memory
follows.

> Caveat: an opencode group that enables the `opencode-claude-memory` plugin
> (`memory_*` tools) writes to a separate structured store, not `CLAUDE.local.md`
> — that path is not covered by this symlink. The default (no plugin) uses
> `CLAUDE.local.md`.

## See also

- `.claude/skills/add-agy/SKILL.md` — install + auth + configuration.
- [provider-migration.md](provider-migration.md) — switching a group between
  providers.

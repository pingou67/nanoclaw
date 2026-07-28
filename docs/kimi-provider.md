# The `kimi` provider (Kimi Code CLI)

Runs an agent group on [Kimi Code](https://github.com/MoonshotAI/kimi-cli)
instead of the Claude Agent SDK. Same poll-loop, same container infra, same
MCP servers, same live-status and background machinery — only the model
harness changes.

```bash
ncl groups config update --id <group-id> --provider kimi --model kimi-code/k3 --effort high
ncl groups restart --id <group-id>
```

## Prerequisites

Kimi Code is installed and authenticated **on the host**, not in the image:

```bash
# installs to ~/.kimi-code (binary at ~/.kimi-code/bin/kimi)
kimi login          # device-code OAuth
kimi doctor         # validates config.toml / tui.toml
```

The host install is the single source of truth: every container mounts that
same binary and the same OAuth credentials. Upgrading the host install
upgrades every group at their next spawn — there is nothing to rebuild.

## How a turn runs

One subprocess per turn:

```
kimi -p <prompt> --output-format stream-json [--model …] [--session <id>]
```

`stream-json` is an OpenAI-shaped chat log on stdout, one JSON object per line
— `assistant` lines carry prose or `tool_calls`, `tool` lines carry results,
and a trailing `meta` line publishes the session id used as the continuation.

**Tool output is interleaved as bare text on the same stream** (a Bash call
prints its own result, and kimi appends notices like `Shell cwd was reset to
…`). The parser JSON-probes every line and silently drops non-objects; a
strict parser dies on the first tool the agent runs.

Because the session id only lands on the trailing line, the `init` event is
emitted at the END of the first turn rather than up front.

## Container wiring

| Mount | Mode | Why |
|---|---|---|
| `~/.kimi-code/bin/kimi` → `/usr/local/bin/kimi` | ro | 160 MB binary, mounted not baked (same trade-off as rtk) |
| `<sessionDir>/kimi-home` → `/kimi-home` | **rw** | `KIMI_CODE_HOME`; staged config + kimi's own transcripts/logs |
| `~/.kimi-code/credentials` → `/kimi-home/credentials` | **rw** | see below |
| `~/.kimi-code/config.toml` → `/kimi-base-config.toml` | ro | operator's provider block, overlaid per group |

**The credentials mount must be writable.** The OAuth access token lives 900
seconds and is renewed against a rotating refresh token; read-only would
authenticate for exactly one turn and then fail permanently. Sharing the host
directory keeps one source of truth — a container refresh propagates back to
the host install, and kimi serializes concurrent refreshes with its own OAuth
lock (only disabled by `KIMI_DISABLE_OAUTH_LOCK`, which we never set).

## Instructions: AGENTS.md, not CLAUDE.md

Kimi reads `AGENTS.md` (project root and `$KIMI_CODE_HOME/AGENTS.md`) and
**never** `CLAUDE.md`. It also does **not** expand the `@./…` includes our
composed `CLAUDE.md` is built from — pointing it at that file would hand the
model a list of unresolved import lines.

So the provider concatenates the same concrete files the opencode provider
lists, into `$KIMI_CODE_HOME/AGENTS.md`:

- `/app/CLAUDE.md` — shared base
- `/workspace/agent/.claude-fragments/*.md` — per-group persona + MCP guidance
- `/workspace/agent/CLAUDE.local.md`

Keep that list in sync with `container/agent-runner/src/providers/opencode.ts`.
Writing into the session home rather than the group workspace keeps the
group's files free of generated content.

Shared memory is injected as `<system_instructions>` on a fresh session's
first turn (no continuation), like opencode and agy — kimi has no
SessionStart hook.

## MCP

Written to `$KIMI_CODE_HOME/mcp.json` in kimi's Claude-compatible shape:
`{"mcpServers": {…}}`, stdio servers keyed off `command`, remote ones off
`url` (+ optional `headers`). Our nanoclaw-only `instructions` key is dropped
— the per-server guidance still reaches the model through the
`.claude-fragments/mcp-<name>.md` files folded into AGENTS.md.

> **Gotcha — the proxy silently kills remote MCP servers.** OneCLI exports
> `http_proxy` / `https_proxy` (lowercase, with credentials) plus
> `NODE_USE_ENV_PROXY=1`. Kimi's HTTP client is undici, which honours those,
> so a remote MCP server on the LAN is routed through the gateway, fails with
> `ERR_HPE_INVALID_CONSTANT`, and is **dropped without a log line** — its
> tools simply never appear. `src/container-runner.ts` clears all four proxy
> variables for `kimi` for that reason. Clearing only the uppercase pair looks
> like a fix and changes nothing. `curl` hides the problem entirely: it
> ignores uppercase `HTTP_PROXY` by design, so a manual Bash fallback succeeds
> while the MCP transport fails.

## Model and effort

`--model` takes a kimi catalog alias (`kimi-code/k3`, `kimi-code/k3-256k`,
`kimi-code/kimi-for-coding`). `effort` is written into the staged
`config.toml` because kimi has no per-invocation effort flag; the Claude
vocabulary is folded onto kimi's `support_efforts = ["low","high","max"]`:

| ours | kimi |
|---|---|
| `low` | `low` |
| `medium`, `high` | `high` |
| `xhigh`, `max` | `max` |

Anything else is left unset so the model default applies. A group that pins
neither model nor effort inherits the operator's `config.toml` untouched.

## Known limits vs Claude Code

- **No structured delivery.** Claude routes replies through the SDK's
  `send_message` tool (`structuredDelivery`); kimi has no equivalent
  structured surface, so it uses the legacy `<message to="…">` envelope path,
  like opencode and agy.
- **Prompt goes through argv.** Kimi has no stdin prompt mode
  (`--output-format` is rejected outside `-p`), and Linux caps one argument at
  128 KiB. Past ~96 KB the provider spills the prompt to a file in the session
  home and passes a pointer the model reads — graceful, but a turn that large
  changes shape.
- **`AskUserQuestion` can stall a headless turn.** `--auto` and `--yolo` are
  both rejected alongside `-p`; prompt mode auto-approves tool calls but a
  question has no answerer. The host idle ceiling reaps it.

## Files

| File | Purpose |
|---|---|
| `container/agent-runner/src/providers/kimi.ts` | The provider (spawn, stream parse, home staging) |
| `container/agent-runner/src/providers/kimi.test.ts` | Parser / config-overlay / MCP-shape tests |
| `src/providers/kimi.ts` | Host-side mounts + env |
| `src/providers/kimi-registration.test.ts` | Barrel registration guard |
| `src/container-runner.ts` | Proxy clearing for `kimi` (see gotcha above) |

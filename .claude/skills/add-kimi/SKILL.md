---
name: add-kimi
description: Use Kimi Code (MoonshotAI/kimi-cli) as an agent provider. A group answers with Kimi K3 via the kimi CLI instead of the Claude Agent SDK — same poll-loop, container infra, MCP (stdio and remote), memory, live-status, background. Per-group via `ncl groups config update --provider kimi`. Needs the `kimi` CLI installed and OAuth-logged-in on the host.
---

# Kimi Code agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container; the
backend is chosen per group with **`provider`**. The `kimi` provider drives
MoonshotAI's **Kimi Code CLI**, so a group answers with Kimi models at parity
with the Claude Code containers — same MCP servers, memory tree, live-status,
background, `ncl`.

Like agy (and unlike opencode), the CLI is a **single host binary plus a host
OAuth login**, both mounted into the container at spawn. **No image rebuild**:
the provider source ships in the bind-mounted agent-runner tree.

Reference doc for how it works: `docs/kimi-provider.md`.

## Install

### Pre-flight (idempotent)

If all of the following exist, skip to **Host auth**:

- `src/providers/kimi.ts` and `container/agent-runner/src/providers/kimi.ts`
- `import './kimi.js';` in **both** `src/providers/index.ts` and
  `container/agent-runner/src/providers/index.ts`
- the `proxyClearingArgs` import **and** call in `src/container-runner.ts`
- `src/providers/kimi-registration.test.ts`, `src/providers/kimi-proxy.test.ts`,
  `container/agent-runner/src/providers/kimi.test.ts`
- `docs/kimi-provider.md`

Anything missing — continue below. Every step is safe to re-run.

### 1. Fetch the providers branch

The modules live on the `providers` branch of **this fork's origin**
(pingou67/nanoclaw) — upstream has no kimi provider.

```bash
git fetch origin providers
```

### 2. Copy the provider files (wholesale, skill-owned)

```bash
git show origin/providers:src/providers/kimi.ts                                         > src/providers/kimi.ts
git show origin/providers:src/providers/kimi-registration.test.ts                       > src/providers/kimi-registration.test.ts
git show origin/providers:src/providers/kimi-proxy.test.ts                              > src/providers/kimi-proxy.test.ts
git show origin/providers:container/agent-runner/src/providers/kimi.ts                  > container/agent-runner/src/providers/kimi.ts
git show origin/providers:container/agent-runner/src/providers/kimi.test.ts             > container/agent-runner/src/providers/kimi.test.ts
git show origin/providers:docs/kimi-provider.md                                         > docs/kimi-provider.md
```

### 3. Append the self-registration imports

One line at the end of each barrel — skip if already present.

`src/providers/index.ts` and `container/agent-runner/src/providers/index.ts`:

```typescript
import './kimi.js';
```

### 4. Wire the proxy reach-in (two lines, load-bearing)

This is the only edit to a file the skill does not own, and skipping it
produces a failure with **no error message at all** — see *Why this matters*
below.

In `src/container-runner.ts`, next to the existing `import './providers/index.js';`:

```typescript
import { proxyClearingArgs } from './providers/kimi.js';
```

Then, in `buildContainerArgs`, **after** the OneCLI gateway apply and the
Claude-credentials block (so the later `-e` wins), add:

```typescript
  args.push(...proxyClearingArgs(_provider));
```

`proxyClearingArgs` returns `[]` for every provider except `kimi`, so this line
is inert for existing groups.

No dependency and no Dockerfile edit.

### Maintenance (fork model)

The installed tree copy is canonical. After editing a file this skill owns,
mirror it to the branch: `pnpm exec tsx scripts/skills-sync.ts sync add-kimi`.
`pnpm test` (via `scripts/skills-sync.test.ts`) goes red on tree↔branch drift,
a deleted barrel line, or a dropped proxy reach-in — the manifest is
`skill-sync.json` in this directory.

## Host auth

Kimi Code authenticates with **one Moonshot account per host**, through its own
device-code OAuth — **not** OneCLI, not an env var. Two artifacts must exist on
the host that runs kimi groups:

1. **The CLI binary** at `~/.kimi-code/bin/kimi` (~160 MB), from the official
   Kimi Code installer.
2. **An OAuth login**, produced by running the CLI once interactively:

   ```bash
   ~/.kimi-code/bin/kimi login     # device-code flow
   ~/.kimi-code/bin/kimi doctor    # validates config.toml / tui.toml
   ```

Verify end to end before wiring a group:

```bash
cd /tmp && ~/.kimi-code/bin/kimi -p "Reply only: OK" --output-format stream-json
# → {"role":"assistant","content":"OK"}
```

The host contribution (`src/providers/kimi.ts`) mounts the binary read-only at
`/usr/local/bin/kimi`, the operator's `config.toml` read-only at
`/kimi-base-config.toml`, a per-session `KIMI_CODE_HOME` read-write at
`/kimi-home`, and `~/.kimi-code/credentials` **read-write** at
`/kimi-home/credentials`.

> **The credentials mount must stay writable.** Kimi's access token lives 900
> seconds and is renewed against a *rotating* refresh token, so a read-only
> mount authenticates for exactly one turn and then fails permanently. Sharing
> the host directory keeps one source of truth — a container refresh propagates
> back to the host install — and kimi serializes concurrent refreshes with its
> own OAuth lock (only disabled by `KIMI_DISABLE_OAUTH_LOCK`, never set here).

> **Moving a host's kimi auth elsewhere**: copy `~/.kimi-code/` to the new host
> (same Moonshot account). Stop any other process using that login first — a
> rotating refresh token shared by two live hosts will invalidate one of them.

## Configuration

```bash
ncl groups config update --id <agent-group-id> --provider kimi --model kimi-code/k3 --effort high
ncl groups restart --id <agent-group-id>
```

No `--rebuild` (the binary is mounted, not installed). Models come from the
operator's `~/.kimi-code/config.toml` catalog — `kimi-code/k3` (1M context),
`kimi-code/k3-256k`, `kimi-code/kimi-for-coding`. A group that pins neither
model nor effort inherits the operator's config untouched.

`effort` is folded onto kimi's `support_efforts`: `low`→`low`,
`medium`/`high`→`high`, `xhigh`/`max`→`max`.

## Validate

```bash
# 1. typecheck + tests (the guards go red if a barrel or the reach-in drifts)
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test                          # host — kimi registration + proxy guard
docker run --rm --entrypoint sh -v "$PWD:/repo" -w /repo/container/agent-runner \
  <agent-image>:latest -c 'bun test src/providers/kimi.test.ts'

# 2. a real turn on a kimi group, including a remote MCP server if the group
#    has one (that is what the proxy reach-in protects):
ncl tasks create --agent-group-id <agent-group-id> --name kimi-smoke \
  --prompt 'Réponds en UNE ligne: KIMI-OK | MCP=<serveurs MCP dont tu vois les outils>' \
  --process-after "$(date -u -d '+5 seconds' +%Y-%m-%dT%H:%M:%SZ)"
# read the run log at groups/<folder>/tasks/kimi-smoke-*.md
```

## Why this matters (the failure with no error message)

OneCLI exports `http_proxy` / `https_proxy` **in lowercase, with credentials**,
plus `NODE_USE_ENV_PROXY=1`. Kimi's HTTP client is undici, which honours those.
Without step 4, every kimi request is routed through the gateway — including
the ones a **remote (http/sse) MCP server** needs. Those fail with
`ERR_HPE_INVALID_CONSTANT` and kimi drops the server **silently**: no log line,
its tools simply never appear.

Two things make this expensive to diagnose from scratch:

- Clearing only the **uppercase** pair looks like a fix and changes nothing.
- `curl` ignores uppercase `HTTP_PROXY` by design, so the agent reaches the
  same host perfectly well through a Bash fallback while the MCP transport
  fails — the symptom reads as "that MCP server is broken".

## Troubleshooting

| Symptom | Cause |
|---|---|
| `kimi: not found` in the container | Binary missing at `~/.kimi-code/bin/kimi`; the host contribution warns at spawn |
| Works for one turn, then auth errors | `credentials` mounted read-only — the 900 s token cannot be refreshed |
| A **remote** MCP server's tools never appear, no error anywhere | Step 4 missing or partial (uppercase-only) |
| A **stdio** MCP server's tools never appear on a cold container | `npx` package download exceeded the MCP startup budget; raise `KIMI_MCP_STARTUP_TIMEOUT_MS` for the group |
| The agent ignores the group's persona / CLAUDE.md | Kimi reads `AGENTS.md`, never `CLAUDE.md`, and does not expand `@./…`; the provider composes `$KIMI_CODE_HOME/AGENTS.md` — check that list against the opencode provider's |
| A turn hangs with no output | Kimi asked a question: `--auto` / `--yolo` are both rejected alongside `-p`, so nothing answers it. The host idle ceiling reaps the container |

## Notes

- **No structured delivery.** Kimi has no `send_message`-style structured
  surface, so it uses the legacy `<message to="…">` envelope path like opencode
  and agy — not Claude's `structuredDelivery`.
- **Prompt goes through argv.** Kimi has no stdin prompt mode
  (`--output-format` is rejected outside `-p`) and Linux caps one argument at
  128 KiB; past ~96 KB the provider spills the prompt to a file in the session
  home and passes a pointer the model reads.
- **Live-status works**: the provider yields `progress` events from the
  `tool_calls` lines of the `stream-json` stream, summarized by the same
  `summarizeToolUse` helper the other providers use.
- **Continuations**: the session id arrives on the trailing `meta` line of a
  turn, so the `init` event is emitted at the end of the first turn; resume
  uses `--session <id>`.

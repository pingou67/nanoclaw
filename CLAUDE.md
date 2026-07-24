# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged into your existing install. Exit Claude Code (or open a separate terminal) and run `bash migrate-v2.sh` from the shell."*
3. Wait for the user to confirm before doing anything else. Do not run the migration script yourself — it requires an interactive terminal and cannot be run from within Claude Code.

If you are a fresh install (you ran `git clone`, not `git pull`) and there are no conflicts, ignore this banner and continue below.

---

# NanoClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get written into the session's inbound DB, and wake a container. The agent-runner inside the container polls the DB, calls the agent, and writes back to the outbound DB. The host polls the outbound DB and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — cold-DM cache

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ many-to-many via messaging_group_agents (session_mode, engage_mode/engage_pattern, sender_scope, priority)
messaging_groups (one chat/channel on one platform; instance = adapter-instance name, defaults to channel_type; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels.

## Two-DB Session Split

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, delivered, destinations, session_routing.
- `outbound.db` — container writes, host reads. `messages_out`, processing_ack, session_state, container_state.

Exactly one writer per file — no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk_*, schema_version. Migrations live at `src/db/migrations/`.

For ad-hoc queries, use the in-tree wrapper rather than the `sqlite3` CLI: `pnpm exec tsx scripts/q.ts <db> "<sql>"`. Default-output format matches `sqlite3 -list` (pipe-separated, no header).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point |
| `src/router.ts` | Inbound routing |
| `src/delivery.ts` | Polls outbound, delivers via adapter |
| `src/delivery-guard.ts` | Guard-consult pipeline for privileged delivery |
| `src/host-sweep.ts` | 60s sweep (acks, stale, due-wake, recurrence) |
| `src/session-manager.ts` | Session resolution, DB open, heartbeat |
| `src/container-runner.ts` | Spawns per-group Docker containers |
| `src/container-runtime.ts` | Docker CLI wrapper |
| `src/guard/` | Privileged-action decision seam (`guard(action, input)`) |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` |
| `src/modules/approvals/primitive.ts` | Approval registry + `pickApprover` |
| `src/command-gate.ts` | Router-side admin command gate |
| `src/modules/permissions/user-dm.ts` | Cold-DM resolution |
| `src/group-init.ts` | Per-group filesystem scaffold |
| `src/db/` | DB layer + migrations |
| `src/channels/`, `src/channels/channel-defaults.ts` | Channel adapter infra + wiring defaults |
| `src/providers/` | Host-side provider configs |
| `container/agent-runner/src/` | Agent-runner (poll, formatter, provider, MCP) |
| `container/skills/` | Container skills mounted into every session |
| `groups/<folder>/` | Per-agent-group filesystem |
| `scripts/skill-apply.ts` | SKILL.md applier (`nc:` directive fences) |
| `setup/` | Setup wizard + skill driver |
| `migrate-v2.sh` | v1→v2 migration script |

## Admin CLI (`ncl`)

`ncl` queries/modifies the central DB. Host: Unix socket (`src/cli/socket-server.ts`); container: session DB transport.

```
ncl <resource> <verb> [<id>] [--flags]
```

Resources: `groups`, `messaging-groups`, `wirings`, `users`, `roles`, `members`, `destinations`, `sessions`, `tasks`, `user-dms`, `dropped-messages`, `approvals`. See `ncl help` and `src/cli/resources/`.

## Channels and Providers (skill-installed)

Trunk ships no specific channel adapter or non-default provider. The `channels` and `providers` sibling branches hold them; skills (`/add-discord`, `/add-opencode`, …) copy them in. Each `/add-<name>` skill is idempotent: fetch branch → copy modules → wire imports → install pinned deps → build. Channel skills carry install steps as `nc:` directive fences.

**Channel defaults.** Each adapter declares wiring-time defaults (`ChannelDefaults`); per-wiring overrides at creation. Undeclared adapters fall back behaviorally — trunk-only updates change nothing. See `src/channels/channel-defaults.ts` and [docs/api-details.md](docs/api-details.md#channel-defaults).

## Self-Modification

One tier today: `install_packages` / `add_mcp_server` — DB-level container config changes (apt/npm deps, MCP server). Single admin approval; on approve, rebuilds the image when needed, writes an `on_wake` message, kills the container, respawns via `onExit`. The `on_wake` column on `messages_in` ensures only a fresh container's first poll picks it up — dying containers can never steal it. A second tier (draft/activate source edits) is planned.

## Container Config

Per-agent-group runtime config (provider, model, packages, MCP, mounts) lives in `container_configs` (central DB). Materialized to `groups/<folder>/container.json` at spawn. Managed via `ncl groups config get/update` and self-mod MCP tools.

Key flags: `--provider`, `--model`, `--effort`, `--thinking`, `--image-tag`, `--assistant-name`, `--max-messages-per-prompt`, `--cli-scope`. Sub-verbs: `add-mcp-server`, `add-package`, `env-set`, `env-unset`. Full reference: [docs/api-details.md](docs/api-details.md).

**`cli_scope`**: `disabled` (no ncl, instructions excluded from CLAUDE.md), `group` (own group only, default), `global` (unrestricted, set for owner groups via `init-first-agent`).

The `env` column is the canonical place for per-group provider config (OpenCode/OpenRouter/Mistral groups put API keys, base URLs, model IDs there). Host's `.env` is fallback only.

**Changes never take effect mid-session.** Writes are saved to DB, but the running container's env/config is frozen at spawn. Run `ncl groups restart [--rebuild]` to materialize.

## Background tasks (`!background`)

A foreground query can be demoted to background so the user keeps interacting while the long task continues. Two triggers:

- **Manual** — user sends `!background` (or `!bg`) standalone while a turn is in flight.
- **Auto** — when a foreground query has been running > `NANOCLAW_AUTO_BG_THRESHOLD_MS` (default 30s) **and** a new user-visible message arrives. Set to `0` to disable.

When a bg query completes, its result is posted to the channel with a `` `bg-N` `` tag AND injected as `<background-result>` into the next foreground turn's prompt so the agent can act on it.

**`!stop`** — aborts all in-flight activity (fg + every bg) for the session. **`!bg-list`** / **`!bg-cancel [N …]`** — fine-grained bg control. **`!clear`** — wipe the conversation continuation. **Max bg duration** — `NANOCLAW_BG_MAX_DURATION_MS` (default 600s) auto-cancels stale bgs.

Mattermost intercepts `/`-commands before they reach the bot, so the runner's own commands only accept the `!`-form. Live status posts (the `🔧` tool-call updates) run for both fg and bg queries.

Key files: `container/agent-runner/src/poll-loop.ts` (state + transitions), `container/agent-runner/src/formatter.ts` (command detectors), `src/cli/dispatch.ts`, `container/agent-runner/src/providers/summarize.ts` (shared `summarizeToolUse`).

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. Kills running containers; `--message` writes an `on_wake` message and respawns via `onExit`. Without `--message`, containers come back on the next user message.

`killContainer` accepts an `onExit` callback that fires after the process exits — guaranteeing the old container is gone before the new one spawns.

Key files: `src/container-restart.ts`, `src/container-runner.ts` (`killContainer`), `container/agent-runner/src/db/messages-in.ts` (`getPendingMessages`).

## Secrets / Credentials / OneCLI

API keys, OAuth tokens, auth credentials are managed by the OneCLI gateway. Secrets are injected into per-agent containers at request time — never in env vars or chat context. Container agent learns via the `onecli-gateway` container skill. Host wiring: `src/modules/approvals/onecli-approvals.ts`, `ensureAgent()` in `container-runner.ts`. Run `onecli --help`.

Auto-created agents default to `all` secret mode (every matching secret injected). Selective mode = no secrets until assigned (401s on APIs whose credential is in the vault). Use `onecli agents set-secret-mode` or `onecli agents set-secrets`. No container restart needed — the gateway looks up secrets per request.

**Approval-gating credentialed actions** is two-sided:
- **Server-side** (OneCLI gateway): decides when to hold + emit pending approval. As of `onecli@2.2.5` the CLI does NOT expose this; configure via web UI at `http://127.0.0.1:10254`.
- **Host-side**: `onecli.configureManualApproval(cb)` long-polls pending approvals and routes to a human via `pickApprover` + `pickApprovalDelivery`. Approvers from `user_roles` (scoped admins → global admins → owners). No env var like `NANOCLAW_ADMIN_USER_IDS`; roles in DB only.

## Skills

Four types. See [CONTRIBUTING.md](CONTRIBUTING.md).

- **Channel/provider install skills** — `/add-discord`, `/add-slack`, …, `/add-opencode`
- **Utility skills** — code files + `SKILL.md`
- **Operational skills** — `/setup`, `/debug`, `/customize`, `/init-first-agent`, `/manage-channels`, `/init-onecli`, `/update-nanoclaw`
- **Container skills** — `container/skills/`: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `vercel-cli`, `welcome` (channel-specific like `slack-formatting` install with their channel)

### Fork-local skills (this install)

| Skill | What it adds |
|-------|--------------|
| `/add-mattermost` | Native Mattermost adapter + E2E harness |
| `/add-opencode` | OpenCode provider (fork-patched: per-query SSE, plugins, tool-progress) |
| `/add-agy` | Google Antigravity (Gemini) provider |
| `/add-rtk` | rtk token-compression (claude hook, opencode plugin, agy rules) |
| `/add-opencode-memory` | `memory_*` tools for opencode groups |
| `/add-vikunja` | Vikunja task-management MCP server |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## PR Hygiene

Before creating a PR:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Show the output and wait for approval. Installation-specific files (group files, `.claude/settings.json`, local configs) should not be included.

## Development

Run commands directly — don't tell the user to run them.

```bash
pnpm run dev          # Host via tsx (no watch)
pnpm run build        # Compile host TypeScript
./container/build.sh  # Rebuild agent container image
pnpm test             # Host tests (vitest)
```

Container typecheck is a separate tsconfig: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`. For host-specific pnpm/bun PATH gotchas see `CLAUDE.local.md`.

Service management:
```bash
# macOS (launchd)
launchctl load|unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # restart
# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

## Troubleshooting

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first, then `logs/nanoclaw.log` |
| Setup logs | `logs/setup.log`, `logs/setup-steps/*.log` |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db`, `outbound.db` |

Container logs are lost after the container exits (`--rm` flag). If the agent silently failed inside, there's no persistent log.

## Timestamps

Two rules, no exceptions:

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC with `Z`). Never `datetime('now')`. In pure-SQL contexts use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. SQL-side *comparisons* wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or a user renders in the install timezone — `formatLocalTime` / `formatLocalStamp` from `src/timezone.ts` / `container/agent-runner/src/timezone.ts`. `--json` output, DB values, and operator logs stay ISO.

## Supply Chain Security (pnpm)

`pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (3 days). New package versions must exist on the npm registry for 3 days before pnpm resolves them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | Full architecture writeup |
| [docs/api-details.md](docs/api-details.md) | Host API + DB schema details |
| [docs/db.md](docs/db.md) | DB architecture overview |
| [docs/db-central.md](docs/db-central.md) | Central DB schema + migrations |
| [docs/db-session.md](docs/db-session.md) | Per-session DB schemas + seq parity |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP |
| [docs/isolation-model.md](docs/isolation-model.md) | Three-level channel isolation |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Runtime split, lockfiles, image build |
| [docs/skill-directives.md](docs/skill-directives.md) | `nc:` directive reference |
| [docs/skill-engine-seam.md](docs/skill-engine-seam.md) | Skill-engine consumer contract |
| [docs/templates.md](docs/templates.md) | Agent templates |
| [docs/agy-provider.md](docs/agy-provider.md) | The `agy` provider (Gemini) |
| [docs/provider-migration.md](docs/provider-migration.md) | Switching providers live |
| [docs/migration-dev.md](docs/migration-dev.md) | v1→v2 migration dev guide |
| [docs/customizing.md](docs/customizing.md) | Short intro to customizing |
| [docs/skills-model.md](docs/skills-model.md) | Skills model in full |
| [docs/skill-guidelines.md](docs/skill-guidelines.md) | Skill-writing checklist |
| [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) | v1→v2 architecture diff |
| [docs/local-patches/README.md](docs/local-patches/README.md) | Fork-local patch map |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

Agent container = **Bun**; host = **Node + pnpm**. Communication only via session DBs. Details: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding/bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit `bun.lock`. Do not run `pnpm install` there.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies. Check release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g`.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~503) → keep `exec bun ...` so signals forward cleanly.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with CJK content (CJK conversations, timezone like `Asia/Tokyo`/`Shanghai`/etc., system locale, or needs to render CJK in screenshots/PDFs/scraped pages), offer to enable it:

```bash
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env`. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.

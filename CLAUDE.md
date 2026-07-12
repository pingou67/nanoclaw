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

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels (`agent-shared`, `shared`, separate agents).

## Two-DB Session Split

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, delivered, destinations, session_routing.
- `outbound.db` — container writes, host reads. `messages_out`, processing_ack, session_state, container_state.

Exactly one writer per file — no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk_* (for the Chat SDK bridge), schema_version. Migrations live at `src/db/migrations/`.

For ad-hoc queries from skills or scripts, use the in-tree wrapper rather than the `sqlite3` CLI: `pnpm exec tsx scripts/q.ts <db> "<sql>"`. The host setup intentionally avoids depending on the `sqlite3` binary (`setup/verify.ts:5`); the wrapper goes through the `better-sqlite3` dep that setup already installs and verifies. Default-output format matches `sqlite3 -list` (pipe-separated, no header) so existing skill text reads identically.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions (schedule, approvals, etc.) |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; manages heartbeat path |
| `src/container-runner.ts` | Spawns per-agent-group Docker containers with session DB + outbox mounts, OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Docker CLI wrapper (runtime binary, host-gateway args, mount args), orphan cleanup |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — owner / global admin / scoped admin / member resolution against `user_roles` + `agent_group_members` |
| `src/modules/approvals/primitive.ts` | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, approval-handler registry |
| `src/command-gate.ts` | Router-side admin command gate — queries `user_roles` directly (no env var, no container-side check) |
| `src/modules/approvals/onecli-approvals.ts` | OneCLI credentialed-action approval bridge |
| `src/modules/permissions/user-dm.ts` | Cold-DM resolution + `user_dms` cache |
| `src/group-init.ts` | Per-agent-group filesystem scaffold (CLAUDE.md, skills) — agent-runner source is a shared read-only mount, not copied per group |
| `src/db/container-configs.ts` | CRUD for `container_configs` table (per-group container runtime config) |
| `src/backfill-container-configs.ts` | Migrates legacy `container.json` files into the DB on startup |
| `src/container-restart.ts` | Kill + on-wake respawn for agent group containers |
| `src/db/` | DB layer — agent_groups, messaging_groups, sessions, container_configs, user_roles, user_dms, pending_*, migrations |
| `src/channels/` | Channel adapter infra (registry, Chat SDK bridge); specific channel adapters are skill-installed from the `channels` branch |
| `src/channels/channel-defaults.ts` | Wiring-creation helpers over adapter-declared channel defaults (`resolveWiringDefaults`, `resolveThreadPolicy`, engage validation) |
| `src/providers/` | Host-side provider container-config (`claude` baked in; `opencode` etc. installed from the `providers` branch) |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, provider abstraction, MCP tools, destinations |
| `container/skills/` | Container skills mounted into every agent session (`agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `vercel-cli`, `welcome`; channel-specific skills like `slack-formatting` and `whatsapp-formatting` install with their channel) |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills) — agent-runner source is a shared read-only mount, not copied per group |
| `scripts/init-first-agent.ts` | Bootstrap the first DM-wired agent (used by `/init-first-agent` skill) |
| `migrate-v2.sh` + `setup/migrate-v2/` | v1→v2 migration. Standalone script: `bash migrate-v2.sh`. Seeds DB, copies groups/sessions, installs channels, builds container, offers service switchover, then hands off to `/migrate-from-v1` skill for owner setup and CLAUDE.md cleanup. See [docs/migration-dev.md](docs/migration-dev.md). |
| `nanoclaw.sh --uninstall` + `setup/uninstall/` | Uninstall this copy only (slug-scoped): service, containers + image, `data/`, `logs/`, `groups/`, this copy's OneCLI agents. Confirms per group; `--dry-run` previews, `--yes` skips prompts. Other copies and the shared OneCLI app are untouched. Bypasses bootstrap entirely; `uninstall.sh` is a pointer that execs it. |

## Admin CLI (`ncl`)

`ncl` queries and modifies the central DB — agent groups, messaging groups, wirings, users, roles, and more. On the host it connects via Unix socket (`src/cli/socket-server.ts`); inside containers it uses the session DB transport (`container/agent-runner/src/cli/ncl.ts`).

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

| Resource | Verbs | What it is |
|----------|-------|------------|
| groups | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package | Agent groups (workspace, personality, container config) |
| messaging-groups | list, get, create, update, delete | A single chat/channel on one platform |
| wirings | list, get, create, update, delete | Links a messaging group to an agent group (session mode, triggers) |
| users | list, get, create, update | Platform identities (`<channel>:<handle>`) |
| roles | list, grant, revoke | Owner / admin privileges (global or scoped to an agent group) |
| members | list, add, remove | Unprivileged access gate for an agent group |
| destinations | list, add, remove | Where an agent group can send messages |
| sessions | list, get | Active sessions (read-only) |
| tasks | list, get, create, update, cancel, pause, resume, delete, run, append-log | Scheduled tasks for an agent group |
| user-dms | list | Cold-DM cache (read-only) |
| dropped-messages | list | Messages from unregistered senders (read-only) |
| approvals | list, get | Pending approval requests (read-only) |

Key files: `src/cli/dispatch.ts` (dispatcher + approval handler), `src/cli/crud.ts` (generic CRUD registration), `src/cli/resources/` (per-resource definitions).

## Channels and Providers (skill-installed)

Trunk does not ship any specific channel adapter or non-default agent provider. The codebase is the registry/infra; the actual adapters and providers live on long-lived sibling branches and get copied in by skills:

- **`channels` branch** — Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud, Signal, WeChat, DeltaChat, Emacs (+ helpers, tests, channel-specific setup steps). Installed via `/add-<channel>` skills.
- **`providers` branch** — OpenCode (and any future non-default agent providers). Installed via `/add-opencode`.

Each `/add-<name>` skill is idempotent: `git fetch origin <branch>` → copy module(s) into the standard paths → append a self-registration import to the relevant barrel → `pnpm install <pkg>@<pinned-version>` → build.

**Channel defaults.** Each adapter declares its wiring-time defaults (`ChannelDefaults`: per DM/group context — engage mode/pattern, thread policy, unknown-sender policy — plus mention signaling). Exactly two levels: the adapter declaration, and the per-wiring override chosen at creation — no per-instance DB config table. Undeclared (stale) adapters resolve through a behavior-faithful fallback, so a trunk update alone changes nothing. See [docs/api-details.md](docs/api-details.md#channel-defaults) and `src/channels/channel-defaults.ts`.

## Self-Modification

One tier of agent self-modification today:

1. **`install_packages` / `add_mcp_server`** — changes to the per-agent-group container config in the DB (apt/npm deps, wire an existing MCP server). Single admin approval per request; on approve, the handler in `src/modules/self-mod/apply.ts` rebuilds the image when needed (`install_packages` only), writes an `on_wake` message, kills the container, and respawns via `onExit` callback. The on-wake message is only picked up by the fresh container's first poll — dying containers can never steal it. `container/agent-runner/src/mcp-tools/self-mod.ts`.

A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

## Container Config

Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, etc.) lives in the `container_configs` table in the central DB. Materialized to `groups/<folder>/container.json` at spawn time so the container runner can read it. Managed via `ncl groups config get/update` and the self-mod MCP tools.

**Scalar fields** — set in one shot via `ncl groups config update --id <gid> [--flag value]…`:

| Flag | Column | Notes |
|------|--------|-------|
| `--provider` | `provider` | `claude` \| `opencode` \| `mock` |
| `--model` | `model` | Alias (`sonnet`) or full ID (`claude-sonnet-4-6`, `mistral/mistral-medium-latest`, `openrouter/google/gemma-4-26b-a4b-it`) |
| `--effort` | `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `--thinking` | `thinking` | `adaptive` (Claude decides), `enabled` (pair with `--thinking-budget-tokens N`), `disabled`, or `none` to clear |
| `--image-tag` | `image_tag` | Override the default agent image for this group |
| `--assistant-name` | `assistant_name` | Display name used in destinations / system prompt |
| `--max-messages-per-prompt` | `max_messages_per_prompt` | Batch cap on inbound messages per agent turn |
| `--cli-scope` | `cli_scope` | See table below |

**JSON-typed fields** — dedicated sub-verbs (one entry at a time, mirrors the `mcp-server` / `package` pattern):

| Verb | What it sets |
|------|--------------|
| `config add-mcp-server` / `config remove-mcp-server` | Entries in `mcp_servers` |
| `config add-package` / `config remove-package` | Entries in `packages_apt` / `packages_npm` (requires `--rebuild`) |
| `config env-set --key K --value V` | Per-group env var in `env` (overrides host env at spawn) |
| `config env-unset --key K` | Remove a per-group env var (use `--key __all__` to clear all) |

The `env` column is the canonical place for per-group provider config — OpenCode/OpenRouter/Mistral groups put their `OPENCODE_PROVIDER`, `OPENCODE_MODEL`, `ANTHROPIC_BASE_URL`, `OPENCODE_API_KEY`, `OPENCODE_REASONING_EFFORT`, `OPENROUTER_PROVIDERS` (CSV → `extraBody.provider.order`) here. Opencode-go groups that want plugins (e.g. `opencode-claude-memory` for `memory_*` tools) set `NANOCLAW_OPENCODE_PLUGINS` to a JSON array of npm package names; the agent-runner's `buildOpenCodeConfig` reads it and adds the `plugin` field to the opencode config it ships via `OPENCODE_CONFIG_CONTENT`. The host's `.env` is fallback only.

**Changes never take effect mid-session.** All `config update` / `env-set` / `add-mcp-server` writes are saved to the DB, but the running container has its env/config frozen at spawn. Run `ncl groups restart --id <gid>` (or `--rebuild` for package/image changes) to materialize.

**`cli_scope`** — controls what the agent can do with `ncl` from inside the container:

| Value | Behavior |
|-------|----------|
| `disabled` | Agent never learns about ncl (instructions excluded from CLAUDE.md). Host dispatch rejects any `cli_request`. |
| `group` (default) | Agent can access `groups`, `sessions`, `destinations`, `members`, `tasks` only, scoped to its own agent group. `--id` and group args are auto-filled. Cross-group access rejected. `cli_scope` changes blocked. |
| `global` | Unrestricted. Set automatically for owner agent groups via `init-first-agent`. |

Key files: `src/db/container-configs.ts`, `src/container-config.ts`, `src/cli/resources/groups.ts` (CLI verbs), `src/providers/opencode.ts` (per-group env merge), `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts` (instructions exclusion).

## Background tasks (`/background`)

A foreground query can be demoted to background so the user keeps interacting with the agent while the long task continues. Two triggers:

- **Manual** — user sends `/background` (or `/bg`) as a standalone message while a turn is in flight. The current query becomes `bg-N`, the foreground slot is freed, the next user message starts a fresh foreground.
- **Auto** — when a foreground query has been running > `NANOCLAW_AUTO_BG_THRESHOLD_MS` (default 30 000 ms) **and** a new user-visible message arrives. The smart trigger only fires when the user is actively waiting — silence means "let it finish, no rush". Set to `0` to disable auto-bg entirely.

When a bg query completes, its final assistant text is:
1. Posted to the channel with a `` `bg-N` `` prefix on each `<message to="…">` block
2. Queued as `<background-result job-id="bg-N" …>…</background-result>` and injected as preamble into the **next foreground turn's prompt** so the agent has the result in context (can act on it: "ok réponds au 2e mail que tu as trouvé").

### Stopping everything (`!stop`)

`!stop` (standalone message) aborts **all** in-flight activity for the session — the foreground query and every background job — via `stopAllActivity()`. It finalizes each live-status post into a `⏹ Arrêté` marker, clears the fg slot + bg map + pending bg results, and acknowledges with `⏹ Arrêté — N tâche(s) interrompue(s)`. Detected in two places: the follow-up poller inside `processQuery` (when a foreground query is mid-flight — checked before `!background` and the generic runner-command bail) and the outer-loop command path (when only bg jobs are running). It does **not** wipe the SDK continuation — the conversation resumes normally on the next message (use `!clear` for that). Abort semantics match `!background`: the slot frees and the display cleans immediately; the underlying SDK turn unwinds on its next event with its output discarded.

The bg query uses its own SDK subprocess + session id; its continuation is NOT persisted (deliberate — keeps the foreground session clean). Tradeoff: tool-call history from the bg turn is lost, only the final assistant text survives via injection.

### Runner commands — all `!`-prefixed (no `/`-form)

Mattermost intercepts every `/`-command before it reaches the bot ("command not found" in the UI, never posted), so the runner's command detectors only accept the `!`-form. The runner's 6 commands:

- **`!help`** (alias `!aide`) — list every `!`-command with description and usage example. Posted directly by the outer loop when the user sends the command, no SDK call involved.
- **`!background`** (alias `!bg`) — demote the current foreground query to background, free the slot for new messages. The bg's eventual result is posted with a `[bg-N]` tag and injected into the next foreground turn's prompt.
- **`!stop`** — abort all in-flight activity (fg + every bg). See section above.
- **`!live`** — toggle the live-status-post feature (default ON). When OFF, the agent works silently in the channel.
- **`!clear`** — wipe the conversation continuation. The next message starts with a fresh SDK session (no memory of prior turns).
- **`!bg-list`** / **`!bg-cancel [N]`** — fine-grained bg control. See [Per-bg control](#per-bg-control-bg-list--bg-cancel) below.

All commands are detected on **standalone** messages only (no extra text, no mid-text). The `categorizeMessage` upstream router also accepts both `/` and `!` prefixes for the admin-routing path (e.g. `/compact` / `!compact`), but the runner's own detectors only fire on the `!`-form.

### Per-bg control (`!bg-list` / `!bg-cancel`)

When several bg jobs are running (e.g. user re-asked during a long one, and the demoted fg spawned a 2nd bg), the user needs finer control than "abort everything". Two commands, all `!`-prefixed because Mattermost intercepts every `/`-command before it reaches the bot:

- **`!bg-list`** — lists every running bg with its id, elapsed seconds, last live-status action, and platform id. Returns "Aucune tâche en background." if the map is empty.

- **`!bg-list`** — lists every running bg with its id, elapsed seconds, last live-status action, and platform id. Returns "Aucune tâche en background." if the map is empty.
- **`!bg-cancel [N …]`** — with no N, cancels every bg (the fg is untouched — use `!stop` for that). With one or more N (e.g. `!bg-cancel 2`), cancels only those bgs; reports not-found ids if the bg already completed. Each cancel finalizes the live status with a `cancelled` marker and the next iteration of the poll heartbeat reaps any newly-stale ones.

**Max bg duration auto-kill** — any bg older than `NANOCLAW_BG_MAX_DURATION_MS` (default 600 000 = 10 min) is auto-cancelled with a `⏹ bg-N arrêté (max duration Xs atteinte)` notice. Prevents a stuck model (e.g. looping on a 69s IMAP timeout) from spinning actions forever — symptom in `#mattermost_dm` 2026-06-19: bg-1 reached 141 actions / 429s on a hung IMAP call before the user got any signal. Set to `0` to disable the auto-kill (e.g. for a long-running batch analysis).

Key files: `container/agent-runner/src/poll-loop.ts` (module-level `activeForegroundQuery` / `activeBackgroundQueries` state, `transitionToBackground`, `consumePendingBgResults`, `cancelBackgroundJob` / `cancelAllBackgroundJobs` / `listBackgroundJobs` / `reapStaleBackgroundJobs`), `container/agent-runner/src/formatter.ts` (`isBackgroundCommand` / `isBgListCommand` / `isBgCancelCommand` / `parseBgCancelIds`).

### Live status post (`/live`)

While a query is in flight, the agent maintains a **single status post** in the channel that updates in place with the latest tool call — e.g. `🔧 imap_search_emails(folder=Archives) — 12 actions • 28s`. Throttled to 2.5s between edits. Created on the first SDK `progress` event of a turn, finalized on the `result` event.

- **Toggle**: `/live` standalone message flips the per-session setting (persisted in outbound.db `session_state.live_enabled`). Default ON.
- **Interactive turns only**: live status is suppressed for scheduled-task turns (cron weekly summary, daily reminder, news digest…). A turn is "interactive" iff its initial batch contains a `chat`/`chat-sdk` message; pure `task` turns run silently (`ActiveQuery.interactive` gates `updateLiveStatus`).
- **Tool calls feed the status**: the Claude provider's `translateEvents` emits a progress event for each assistant `tool_use` block, and the opencode provider's `message.part.updated` switch yields one per `ToolPart` in `pending`/`running` state (dedupe by `callID` so a single call → one progress). Both routes go through the shared `summarizeToolUse` helper (`providers/summarize.ts`) to format the one-liner — so the status text looks the same regardless of which agent is driving.
- **Periodic refresh**: a 3s ticker (`liveStatusRefresh`) re-renders the post with the last known text even when no new tool event arrives, so the `Xs` counter keeps advancing during a long single tool call (e.g. a heavy IMAP search) instead of looking frozen.
- **Finalization**: on `result`/error the post is **edited** into a discreet `✅ Terminé en Xs, N actions` marker rather than deleted — deleting leaves an ugly Mattermost `(message deleted)` placeholder for ~30s. `finalizeLiveStatus` retries resolving the platform post id for a few seconds (short-turn race: the create may not have round-tripped through the host delivery poll yet).
- **Orphan cleanup**: the active post ref (`outboundId` + `platformMsgId`) is persisted to `session_state.live_status_post` on create/resolution. If the container dies mid-turn (crash, absolute-ceiling kill, manual restart) the `🔧` post would otherwise hang forever — so on startup `cleanupOrphanLiveStatus` finalizes any leftover ref into `✅ Terminé (session précédente interrompue)`.
- **Edit primitive**: reuses the existing Mattermost adapter `operation: 'edit'`/`'delete'` ops (also used by /background).
- **Global kill switch**: `NANOCLAW_LIVE_STATUS_DISABLED=1` env var disables the feature entirely (used by the E2E test harness to keep assertions deterministic — the test waits on the FIRST reply matching a string, and live-status intermediate posts would race with the actual answer).

Bg queries also get their own live status post tagged with `` `bg-N` `` so the user can tell which job is doing what.

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. Kills running containers; if `--message` is provided, writes an `on_wake` message and respawns via `onExit` callback. Without `--message`, containers come back on the next user message. From inside a container, `--id` is auto-filled and only the calling session is restarted.

The `on_wake` column on `messages_in` ensures wake messages are only picked up by a fresh container's first poll iteration. This prevents the race where a dying container (still in its SIGTERM grace period) could steal the message. `killContainer` accepts an optional `onExit` callback that fires after the process exits, guaranteeing the old container is gone before the new one spawns.

Key files: `src/container-restart.ts`, `src/container-runner.ts` (`killContainer`), `container/agent-runner/src/db/messages-in.ts` (`getPendingMessages`).

## Secrets / Credentials / OneCLI

API keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway. Secrets are injected into per-agent containers at request time — none are passed in env vars or through chat context. The container agent sees this via the `onecli-gateway` container skill (`container/skills/onecli-gateway/SKILL.md`), which teaches it how the proxy works, how to handle auth errors, and to never ask for raw credentials. Host-side wiring: `src/modules/approvals/onecli-approvals.ts`, `ensureAgent()` in `container-runner.ts`. Run `onecli --help`.

### Secret modes

Auto-created agents default to `all` secret mode — every vault secret whose host pattern matches is injected automatically, so the common case needs no per-agent setup. If an agent is in `selective` mode it gets no secrets until you assign them, which shows up as a `401` from an API whose credential *is* in the vault. The SDK can't change this; use the CLI (or the web UI at `http://127.0.0.1:10254`):

```bash
onecli agents list                                          # check secretMode
onecli agents set-secret-mode --id <agent-id> --mode all    # inject all matching secrets
onecli agents set-secrets --id <agent-id> --secret-ids ...  # or stay selective, assign specific ones
```

No container restart needed — the gateway looks up secrets per request.

### Requiring approval for credential use

Approval-gating credentialed actions is a **two-sided** flow:

- **Server-side** (OneCLI gateway): decides *when* to hold a request and emit a pending approval. As of `onecli@2.2.5`, the CLI does **not** expose this — `rules create --action` only accepts `block` or `rate_limit`, and `secrets create` has no approval flag. Approval policies must be configured via the OneCLI web UI at `http://127.0.0.1:10254`. If/when the CLI grows an `approve` action, this section needs updating.
- **Host-side** (nanoclaw): receives pending approvals and routes them to a human. `src/modules/approvals/onecli-approvals.ts` registers a callback via `onecli.configureManualApproval(cb)` (long-polls `GET /api/approvals/pending`). The callback uses `pickApprover` + `pickApprovalDelivery` from `src/modules/approvals/primitive.ts` to DM an approver. Approvers are resolved from the `user_roles` table — preference order: scoped admins for the agent group → global admins → owners. There is no env var like `NANOCLAW_ADMIN_USER_IDS`; roles are persisted in the central DB only.

If approvals are configured server-side but the host callback isn't running (or throws), every credentialed call hangs until the gateway times out. Conversely, if the gateway has no rule asking for approval, the host callback never fires regardless of how it's wired.

## Skills

Four types of skills. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy.

- **Channel/provider install skills** — copy the relevant module(s) in from the `channels` or `providers` branch, wire imports, install pinned deps (e.g. `/add-discord`, `/add-slack`, `/add-whatsapp`, `/add-opencode`).
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. a `scripts/` CLI or helper).
- **Operational skills** — instruction-only workflows (`/setup`, `/debug`, `/customize`, `/init-first-agent`, `/manage-channels`, `/init-onecli`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `vercel-cli`, `welcome`; channel-specific skills like `slack-formatting` and `whatsapp-formatting` are copied in by their `/add-<channel>` skill).

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time install, auth, service config |
| `/init-first-agent` | Bootstrap the first DM-wired agent (channel pick → identity → wire → welcome DM) |
| `/manage-channels` | Wire channels to agent groups with isolation level decisions |
| `/customize` | Adding channels, integrations, behavior changes |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials |
| `/migrate-memory` | Carry a group's agent memory across a provider switch (operator-run, both directions) |

### Fork-local skills (this install)

The fork's own additions are distributed as skills too, installable on a clean upstream. Their canonical payload lives on module branches of **origin** (`channels`, `providers`) or in the skill's `resources/`; the installed tree copy is canonical day-to-day and `scripts/skills-sync.ts` mirrors it back (`sync <skill>` after editing a skill-owned file; `check` runs inside `pnpm test` via `scripts/skills-sync.test.ts` and goes red on any drift, including after an upstream update). Map + reliquat: [docs/local-patches/README.md](docs/local-patches/README.md).

| Skill | What it adds |
|-------|--------------|
| `/add-mattermost` | Native Mattermost adapter + E2E harness (`tests/integration/mattermost/`, skill-aware skips) |
| `/add-opencode` | OpenCode provider (fork-patched: per-query SSE, plugins, tool-progress, `summarize.ts`) |
| `/add-agy` | Google Antigravity (Gemini) provider |
| `/add-rtk` | rtk token-compression (claude hook, opencode plugin, agy rules file) |
| `/add-opencode-memory` | `memory_*` tools for opencode groups (shim, no runtime npm install) |
| `/add-vikunja` | Vikunja task-management MCP server |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## PR Hygiene

Before creating a PR, run these checks:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Show the output and wait for approval. Installation-specific files (group files, .claude/settings.json, local configs) should not be included.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # Host via tsx (no watch)
pnpm run build        # Compile host TypeScript (src/)
./container/build.sh  # Rebuild agent container image (nanoclaw-agent:latest)
pnpm test             # Host tests (vitest)

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

> **Host pnpm is not on the default PATH** — installed at `~/.local/share/pnpm/pnpm` (corepack is EACCES on this host, do **not** `corepack enable`; it pretends to fix pnpm and breaks nothing). Add to your shell env before running tests:
>
> ```bash
> export PNPM_HOME="$HOME/.local/share/pnpm" && export PATH="$PNPM_HOME:$PATH"
> ```
>
> Without it, `pnpm test` works (it falls back to `node_modules/.bin/vitest` from the script), but **`scripts/q.test.ts` fails 7/7** because the tests spawn a sub-`pnpm exec tsx` that can't find the binary.
>
> **Container `bun` is not on the host** — it only lives inside the agent image. Run container tests via:
>
> ```bash
> docker run --rm --entrypoint sh \
>   -v $PWD/container/agent-runner:/ar -w /ar \
>   nanoclaw-agent-v2-c761ecdc:latest -c 'bun test'
> ```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root (or `bun run typecheck` from `container/agent-runner/`).

Service management:
```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

## Troubleshooting

Check these first when something goes wrong:

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full routing chain |
| Setup logs | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step: bootstrap, environment, container, onecli, mounts, service, etc.) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db` (`messages_in`: did the message reach the container?), `outbound.db` (`messages_out`: did the agent produce a response?) |

Note: container logs are lost after the container exits (`--rm` flag). If the agent silently failed inside the container, there's no persistent log to inspect.

## Timestamps

Two rules, no exceptions:

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC with `Z`). Never `datetime('now')` — its naive `YYYY-MM-DD HH:MM:SS` shape is misparsed as local time by `new Date()` and breaks string comparisons against ISO values. In pure-SQL contexts (skill snippets) use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. SQL-side *comparisons* wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or a user renders in the install timezone — `formatLocalTime` (prose) or `formatLocalStamp` (log lines) from `src/timezone.ts` / `container/agent-runner/src/timezone.ts`. `--json` output, DB values, and operator logs stay ISO.

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | Full architecture writeup |
| [docs/api-details.md](docs/api-details.md) | Host API + DB schema details |
| [docs/db.md](docs/db.md) | DB architecture overview: three-DB model, cross-mount rules, readers/writers map |
| [docs/db-central.md](docs/db-central.md) | Central DB (`data/v2.db`) — every table + migration system |
| [docs/db-session.md](docs/db-session.md) | Per-session `inbound.db` + `outbound.db` schemas + seq parity |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP tool interface |
| [docs/isolation-model.md](docs/isolation-model.md) | Three-level channel isolation model |
| [docs/setup-wiring.md](docs/setup-wiring.md) | What's wired, what's open in the setup flow |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Diagram version of the architecture |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Runtime split (Node host + Bun container), lockfiles, image build surface, CI, key invariants |
| [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) | v1→v2 architecture diff — vocabulary for where v1 things moved |
| [docs/migration-dev.md](docs/migration-dev.md) | Migration development guide — testing, debugging, dev loop |
| [docs/provider-migration.md](docs/provider-migration.md) | Switching a live agent group between providers (e.g. Claude → Codex) — what carries over, rollback |
| [docs/agy-provider.md](docs/agy-provider.md) | The `agy` provider (Google Antigravity / Gemini): auth, lifecycle, MCP plugin mechanism + per-container MCP isolation |
| [docs/customizing.md](docs/customizing.md) | Short intro to customizing via skills |
| [docs/skills-model.md](docs/skills-model.md) | The skills model in full: recipes, tests, upgrades, migrations |
| [docs/skill-guidelines.md](docs/skill-guidelines.md) | Authoritative checklist for writing a skill |
| [docs/templates.md](docs/templates.md) | Agent templates: what they are, stamping via `ncl groups create --template` + the setup wizard, the OneCLI/MCP-credential model, supported providers, and how to contribute one |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies to this tree. Check the release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`, `vercel`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~503) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with Chinese/Japanese/Korean content — conversing in CJK, CJK timezone (e.g., `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Seoul`, `Asia/Taipei`, `Asia/Hong_Kong`), system locale hint, or mentions of needing to render CJK in screenshots/PDFs/scraped pages — offer to enable it:

```bash
# Ensure .env has INSTALL_CJK_FONTS=true (overwrite or append)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# Rebuild and restart so new sessions pick up the new image
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through as a Docker build-arg. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.

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

**Read the fork-local docs first.** Before any non-trivial procedure (update, migration, debug, container rebuild), consult `docs/local-patches/` — especially `POST_UPDATE_CHECKLIST.md` — its **§−1 is read BEFORE launching an update** (stop the service first, `/usr/bin` ahead on PATH, keep the E2E stdout), the rest after (E2E suite §13, `skills-sync.ts check` §0, mounts §M, secrets/périmètre/caviardage §S) — plus `docs/BRANCH-FORK-MAINTENANCE.md` and `CLAUDE.local.md` (host memory: pnpm/bun PATH gotchas). Upstream skills don't know these docs; always supplement their steps with the local checklists.

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

The central database holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk_* (for the Chat SDK bridge), schema_version. SQLite at `data/v2.db` is the default; host code uses the async `DbDriver` boundary. Migrations live at `src/db/migrations/`.

For ad-hoc central queries from skills or scripts, use the in-tree wrapper rather than the `sqlite3` CLI: `pnpm exec tsx scripts/q.ts data/v2.db "<sql>"`. The canonical central path routes through the installed composition; explicit session paths remain direct SQLite. Default output matches `sqlite3 -list` (pipe-separated, no header).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions (schedule, approvals, etc.) |
| `src/delivery-guard.ts` | `DeliveryGuardSpec` + `runGuarded` — the guard-consult pipeline for privileged delivery actions (registry stays in `delivery.ts`) |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; manages heartbeat path |
| `src/container-runner.ts` | Spawns per-agent-group Docker containers with session DB + outbox mounts, OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Docker CLI wrapper (runtime binary, host-gateway args, mount args), orphan cleanup |
| `src/guard/` | Privileged-action decision seam: `guard(action, input)` → allow \| hold \| deny. Module-edge `guard.ts` adapters (cli, agent-to-agent, self-mod, permissions) define each action's decision; ncl commands + delivery actions demand a guard at registration; approved replays carry the approval row as a grant and re-run the checks. Conformance test: `src/guard/conformance.test.ts` |
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
| `container/skills/` | Container skills mounted into every agent session (`agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `welcome`; opt-in skills like `vercel-cli`, `slack-formatting` and `whatsapp-formatting` install with the `/add-*` skill that adds their capability) |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills) — agent-runner source is a shared read-only mount, not copied per group |
| `scripts/init-first-agent.ts` | Bootstrap the first DM-wired agent (used by `/init-first-agent` skill) |
| `scripts/skill-apply.ts` | Deterministic SKILL.md applier — executes `nc:` directive fences; declare/emit core, journaled + idempotent |
| `scripts/skill-directives.ts` + `scripts/skill-policy.ts` | `nc:` grammar parser + lint; UI-free driver policy derived from document structure (gate confirm, URL offer) |
| `setup/lib/skill-driver.ts` + `setup/channels/run-channel-skill.ts` | Setup wizard's skill consumer: clack rendering of engine events + the generic channel-install flow |
| `migrate-v2.sh` + `setup/migrate-v2/` | v1→v2 migration. Standalone script: `bash migrate-v2.sh`. Seeds DB, copies groups/sessions, installs channels, builds container, offers service switchover, then hands off to `/migrate-from-v1` skill for owner setup and CLAUDE.md cleanup. See [docs/migration-dev.md](docs/migration-dev.md). |
| `nanoclaw.sh --uninstall` + `setup/uninstall/` | Uninstall this copy only (slug-scoped): service, containers + image, `data/`, `logs/`, `groups/`, this copy's OneCLI agents. Confirms per group; `--dry-run` previews, `--yes` skips prompts. Other copies and the shared OneCLI app are untouched. Bypasses bootstrap entirely; `uninstall.sh` is a pointer that execs it. |

## Admin CLI (`ncl`)

`ncl` queries/modifies the central DB. Host: Unix socket (`src/cli/socket-server.ts`); container: session DB transport.

```
ncl <resource> <verb> [<id>] [--flags]
```

Resources: `groups`, `messaging-groups`, `wirings`, `users`, `roles`, `members`, `destinations`, `sessions`, `tasks`, `user-dms`, `dropped-messages`, `approvals`. See `ncl help` and `src/cli/resources/`.

## Channels and Providers (skill-installed)

Trunk ships no specific channel adapter or non-default provider. The `channels` and `providers` sibling branches hold them; skills (`/add-discord`, `/add-opencode`, …) copy them in. Each `/add-<name>` skill is idempotent: fetch branch → copy modules → wire imports → install pinned deps → build. Channel skills carry install steps as `nc:` directive fences.

**Channel defaults.** Each adapter declares wiring-time defaults (`ChannelDefaults`); per-wiring overrides at creation. Undeclared adapters fall back behaviorally — trunk-only updates change nothing. See `src/channels/channel-defaults.ts` and [docs/api-details.md](docs/api-details.md#channel-defaults).

**`/add-kimi` is not installed** (removed 2026-08-02). If it is ever reinstalled, note that it carries one reach-in beyond the usual barrel line: `src/container-runner.ts` must import and call `proxyClearingArgs` from the provider, or every **remote** MCP server dies silently under kimi. Its `skill-sync.json` `requiredLines` guard that. Reinstalling also means re-adding the host-binary entry to `scripts/supply-watch.ts`, which the skill does **not** own — the removal took it out.

**`/add-codex` is installed** (2026-08-03, group `testor-codex` on GPT-5.6 Terra / effort `medium`). It is an *upstream* skill, but this install carries three deltas without which the published payload does not even compile against `upstream/main` — most notably a **cherry-pick of the unmerged `a6a46621`** (`file` events, so codex-generated images actually reach the channel). We therefore hold code **ahead of** upstream here: expect a `poll-loop.ts` conflict the day that PR merges, and keep both `deliverErrorResult` and `deliverHarnessFile`. Full rationale, plus the `@openai/codex` pin deviation and the remote-MCP support added on top of the payload, in [docs/local-patches/README.md](docs/local-patches/README.md#provider-codex--un-patch-porté-en-avance-sur-upstream-2026-08-03).

**Remote MCP servers work under codex** (`url` form in `config.toml`) — the upstream payload only modelled stdio because upstream core requires `command`; this install extends `CodexMcpServer` into a stdio | remote union. The one shape codex cannot express is *arbitrary headers* (it offers only `bearer_token_env_var`); such a server is dropped and **named on stderr**, never silently.

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

### Règle — moindre exposition des secrets (2026-07-30)

**Un secret n'est mis à disposition que des groupes qui en ont un usage fonctionnel.** Pas « tous les groupes similaires », pas « par symétrie », pas « au cas où » : chaque groupe qui détient un secret doit avoir une raison nommable. À appliquer à toute évolution — nouveau groupe, nouveau serveur MCP, clonage d'un canal.

**Bitwarden/Vaultwarden est la source de vérité unique** (compte de service `appvault@`, accès par `rbw`). Deux voies de livraison seulement, choisies non pas par préférence mais par ce que **le protocole permet** :

| | Livraison | Le container voit-il le secret ? | Alimentation |
|---|---|---|---|
| Secret dans un **en-tête HTTP** | OneCLI réécrit l'en-tête à la requête | **non, jamais** | coffre → `scripts/sync-vault-to-onecli.ts` |
| **Tout le reste** (IMAP, fichiers, non-HTTP) | référence `vault:` résolue au spawn | oui, inévitablement | coffre directement |

1. **Injection à la requête (OneCLI)** — dès que le secret voyage dans un en-tête. Le container ne détient qu'un marqueur (`onecli-injected`) ; le périmètre se déclare **côté passerelle** (`agents set-secrets`, mode `selective`), donc un clonage de groupe ne peut pas le recopier. Manifeste : `scripts/vault-onecli-map.json`. Rotation = changer dans Bitwarden puis lancer la synchro ; aucun container à redémarrer, la passerelle résout par requête.
2. **Référence de coffre résolue au spawn** — quand l'injection est impossible. Une valeur d'`env` (ou un `passwordRef`) s'écrit `vault:élément[/champ]` ; `src/secrets/vault.ts` la résout côté hôte au `docker run`. Une référence illisible **refuse le spawn** — jamais de démarrage avec une variable vide dont l'échec surgirait ailleurs. Cas particulier de l'IMAP : `src/secrets/imap-creds.ts` génère un couple `{accounts.json,.key}` **éphémère par session** (clé tirée à chaque fois), monté RO — il n'existe plus aucun `accounts.json` permanent sur l'hôte.
3. **Valeur en clair dans `container_configs`** — dernier recours, à justifier. Ça se retrouve aussi dans `groups/<folder>/container.json` (0600 via `materializeContainerJson`, verrouillé par `container-config.secrets.test.ts`).

> **Ordre de résolution — piège vécu (2026-07-30).** Les `vault:` sont résolus dans `spawnContainer`, **après** l'écriture de `container.json` (qui ne doit contenir que des références) et **avant** `resolveProviderContribution` — car la contribution du provider opencode recopie `groupEnv` et écraserait sinon la valeur résolue par la référence brute. Le symptôme est distant et trompeur (« No credentials configured for opencode.ai »). Verrouillé par `src/secrets/spawn-order.test.ts`.

Ce qui **ne peut pas** être protégé par la passerelle : un secret porté par le **chemin d'une URL** (ha-mcp, `…/private_<token>`) — il n'y a pas d'en-tête à réécrire. Pour ceux-là, la seule mesure est de réduire le nombre de groupes, et de ne jamais les journaliser (le log MCP au démarrage n'imprime que l'`origin`, jamais l'URL complète — voir `container/agent-runner/src/index.ts`).

Vérifier l'état réel à tout moment :

```bash
# Aucun secret en clair ne doit subsister en base (doit valoir 0)
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT count(*) FROM container_configs WHERE mcp_servers LIKE '%sk-%' OR env LIKE '%sk-%'
                                             OR mcp_servers LIKE '%tk_%' OR env LIKE '%tk_%'"
# Qui détient quoi
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT substr(g.id,15), (SELECT group_concat(key,',') FROM json_each(json(c.mcp_servers))), c.additional_mounts
   FROM agent_groups g JOIN container_configs c ON c.agent_group_id=g.id"
pnpm exec tsx scripts/check-secret-scope.ts               # périmètre OneCLI vs besoin réel (sort 1 si écart)
pnpm exec tsx scripts/sync-vault-to-onecli.ts --check      # coffre lisible, cibles prêtes
```

`check-secret-scope.ts` compare les deux moitiés de la règle, qui vivent à des endroits différents et dérivent en silence : le **périmètre** se déclare côté passerelle (`agents set-secrets`), le **besoin** se déclare en base (`container_configs.mcp_servers`). Il signale les deux sens — un secret porté sans le serveur MCP qui le justifie, mais aussi un serveur MCP sans son secret, dont le symptôme est un 401 lointain et non un problème de sécurité apparent. Le lien besoin↔secret se déclare par `requiredBy` dans `scripts/vault-onecli-map.json` ; un secret sans `requiredBy` n'est pas auditable et n'est que signalé. Un agent créé automatiquement naît en mode `all` : le remettre en `selective` fait partie de l'ajout d'un groupe.

**Prérequis d'exploitation** : le coffre doit être déverrouillé pour que les containers démarrent (pinentry automatique, `lock_timeout` long). Si `rbw` est verrouillé, les groupes concernés refusent de spawner avec un message nommant la référence — c'est voulu.

**Approval-gating credentialed actions** is two-sided:
- **Server-side** (OneCLI gateway): decides when to hold + emit pending approval. As of `onecli@2.2.5` the CLI does NOT expose this; configure via web UI at `http://127.0.0.1:10254`.
- **Host-side**: `onecli.configureManualApproval(cb)` long-polls pending approvals and routes to a human via `pickApprover` + `pickApprovalDelivery`. Approvers from `user_roles` (scoped admins → global admins → owners). No env var like `NANOCLAW_ADMIN_USER_IDS`; roles in DB only.

## Skills

Four types. See [CONTRIBUTING.md](CONTRIBUTING.md).

- **Channel/provider install skills** — copy the relevant module(s) in from the `channels` or `providers` branch, wire imports, install pinned deps (e.g. `/add-discord`, `/add-slack`, `/add-whatsapp`, `/add-opencode`).
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. a `scripts/` CLI or helper).
- **Operational skills** — instruction-only workflows (`/setup`, `/debug`, `/customize`, `/init-first-agent`, `/manage-channels`, `/init-onecli`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `welcome`; opt-in skills like `vercel-cli` and the channel formatters are copied in by the `/add-*` skill that adds their capability).

### Fork-local skills (this install)

| Skill | What it adds |
|-------|--------------|
| `/add-mattermost` | Native Mattermost adapter + E2E harness |
| `/add-opencode` | OpenCode provider (fork-patched: per-query SSE, plugins, tool-progress) |
| `/add-agy` | Google Antigravity (Gemini) provider |
| `/add-kimi` | Kimi Code (MoonshotAI) provider — host binary + OAuth mounted |
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

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC with `Z`). Central SQL receives that timestamp as a parameter; never use `datetime('now')` or `strftime(...)` there because they are SQLite-specific and the naive shape is misparsed as local time by `new Date()`. SQLite-only mailbox SQL may use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. SQLite-only comparisons wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or a user renders in the install timezone — `formatLocalTime` (prose) or `formatLocalStamp` (log lines) from `src/timezone.ts` / `container/agent-runner/src/timezone.ts`. `--json` output, DB values, and operator logs stay ISO.

An agent group can override the install timezone (`ncl groups config update --timezone <IANA>`, `""` clears; approval-gated for agent callers). The override grounds that group's scheduling (cron interpretation, `--process-after`, run-log stamps — effective immediately) and the container's `TZ` env (effective on respawn). Host-side operator display (`ncl` human output) stays in the install timezone. Resolution: `resolveGroupTimezone` in `src/container-config.ts` — group override → install global.

## Supply Chain Security (pnpm)

`pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (3 days). New package versions must exist on the npm registry for 3 days before pnpm resolves them.

**Everything outside that policy is covered by `scripts/supply-watch.ts`** — the unified supply-chain watch. One rule everywhere: **nothing installs itself, and a version is only proposed once it has been public for ≥ 3 days** (same window as `minimumReleaseAge`). One daily user timer (`nanoclaw-supply-watch`, 09:00) checks every version pin that ends up in the agent image or on the agent PATH — `container/cli-tools.json`, the Dockerfile `*_VERSION` ARGs (opencode, bun, pnpm), the agent-runner runtime deps (resolved from `bun.lock`) — plus upstream/main drift (commit summary + overlap with our local patches), and sends ONE Mattermost DM digest only when something changed.

```bash
pnpm exec tsx scripts/supply-watch.ts --dry-run   # print the digest without posting
```

Applying stays deliberate: bump the pin, rebuild the image, run the E2E suite. Exclusions (documented in the script header): host pnpm deps (already governed by `minimumReleaseAge` at install) and the `agy` binary (no public version feed — update via `agy update` during maintenance).

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
| [docs/customizing.md](docs/customizing.md) | Short intro to customizing via skills |
| [docs/skills-model.md](docs/skills-model.md) | The skills model in full: recipes, tests, upgrades, migrations |
| [docs/skill-guidelines.md](docs/skill-guidelines.md) | Authoritative checklist for writing a skill |
| [docs/skill-directives.md](docs/skill-directives.md) | `nc:` directive reference: fence grammar, the eight kinds, effects, guards, lint |
| [docs/skill-engine-seam.md](docs/skill-engine-seam.md) | Skill-engine consumer contract (wizard / pipeline / agent-relay) + boundary-rule rationale |
| [docs/templates.md](docs/templates.md) | Agent templates: what they are, stamping via `ncl groups create --template` + the setup wizard, the OneCLI/MCP-credential model, supported providers, and how to contribute one |
| [docs/hardened-image.md](docs/hardened-image.md) | Opt-in: pull the agent image from a registry instead of building it |
| [docs/agy-provider.md](docs/agy-provider.md) | The `agy` provider (Gemini) |
| [docs/SECURITY.md](docs/SECURITY.md) | Modèle de sécurité — §4 porte la nuance fork : la garantie « aucun credential dans le container » ne vaut que pour HTTP |
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
- **Adding a Node CLI the agent invokes at runtime** → append a `{ "name", "version" }` entry to `container/cli-tools.json`, pinned to an exact version (not the Dockerfile). Don't use `bun install -g`. `"onlyBuilt": true` only for packages with a real postinstall — it opts them into running build scripts.
- **Adding an MCP server backed by an npm package** → bake it into `cli-tools.json` and call its **bin**, never `npx -y <pkg>`. `/home/node/.npm` is not persisted, so `npx` re-downloads on every cold container; the SDK's MCP startup budget expires first and the server is dropped **silently** — its tools just never appear, and the same group works fine on the next (warm) turn. Cost us a long diagnosis on gmail + google-calendar (2026-07-28).

**Invariant — a container start pulls nothing from the network.** Everything an agent needs at spawn is in the image or on a mount. Two things are legitimately not: a **remote** MCP server (`type: http`/`sse`) is the service itself, not a download, and `vikunja` runs from the bind-mounted `/app/src` tree. Anything else that fetches at startup is a bug: it makes spawn depend on registry availability, silently drops the server when it is slow, and means no two containers necessarily run the same code. Check with:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT count(*) FROM container_configs, json_each(json(mcp_servers)) WHERE json_extract(value,'\$.command')='npx'"
# must print 0
```
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

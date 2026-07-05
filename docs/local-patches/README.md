# Local patches and operational notes

Documentation of all custom modifications applied to this NanoClaw fork
on top of upstream `qwibitai/nanoclaw`. Mirrors the contents of the
auto-memory store at `~/.claude/projects/-home-pegon-nanoclaw/memory/`.

## Read order

1. **[POST_UPDATE_CHECKLIST.md](POST_UPDATE_CHECKLIST.md)** — what to verify and
   reapply after every `/update-nanoclaw`. Has a one-liner health check
   covering all 7 critical patches.

2. **[V2_MIGRATION_NOTES.md](V2_MIGRATION_NOTES.md)** — the v2.0 migration
   (2026-04-26): what changed, what broke, what was fixed, rollback tag.

3. **[MATTERMOST_V2_ADAPTER.md](MATTERMOST_V2_ADAPTER.md)** — the native v2
   Mattermost channel adapter that replaced the standalone bot containers.
   Architecture, config, threading, attachments, crons, tests.

4. **[CLAUDE_PRO_AUTH.md](CLAUDE_PRO_AUTH.md)** — exact code block to inject
   into `src/container-runner.ts` to mount `~/.claude/.credentials.json`
   read-only into agent containers (Claude Pro subscription auth instead
   of API key).

## Recovery anchors

| Tag | Date | Anchors what state |
|-----|------|---------------------|
| `pre-v2-63ea4d0-20260426-104215` | 2026-04-26 10:42 | Last v1.2.53 commit before v2 merge |
| `pre-mattermost-v2-b2f9232-20260426-201218` | 2026-04-26 20:12 | Just after v2 migration, before Mattermost adapter cutover |
| `backup/pre-v2-63ea4d0-20260426-104215` | (branch) | Same as the tag |
| `backup/pre-mattermost-v2-b2f9232-20260426-201218` | (branch) | Same as the tag |

Disk snapshots:
- `~/nanoclaw-backups/v1.2.53-20260426-104215/` (98M) — full pre-v2
- `~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/` (15M) — src + data + groups + mattermost-bot

## Quick verify

```bash
cd /home/pegon/nanoclaw
# See POST_UPDATE_CHECKLIST.md "Quick health check" section for the full one-liner.
```

## OpenCode provider

[OPENCODE_PROVIDER.md](OPENCODE_PROVIDER.md) — setup non-Anthropic (DeepSeek/Gemma) via OpenCode + OpenRouter avec thinking, caching, vision images + PDF rasterisé.

---

## Conversion en skills (2026-07-02) — carte skills vs reliquat

Les ajouts **additifs et modulaires** du fork sont désormais distribués en
**skills**, installables sur un upstream vierge (modèle upstream : branche de
modules + additive fetch, ou payload `resources/` dans le skill). Les fichiers
installés dans l'arbre restent la copie **canonique** ; le payload est un
miroir généré par `scripts/skills-sync.ts` et gardé en phase par
`scripts/skills-sync.test.ts` (rouge sur tout drift, à chaque `pnpm test`).

### Skill-owned (ne sont PLUS des patchs à re-porter à la main)

| Skill | Payload | Contenu |
|-------|---------|---------|
| `/add-mattermost` | branche `channels` (origin) | `src/channels/mattermost.ts` + guard de registration + harness E2E `tests/integration/mattermost/` + dep `ws` + ligne barrel |
| `/add-opencode` | branche `providers` (origin) | provider opencode PATCHÉ (SSE par query, plugins, tool-progress) + `summarize.ts` + `mcp-to-opencode` + tests + dep `@opencode-ai/sdk` + `ARG OPENCODE_VERSION` Dockerfile + guard Dockerfile + lignes barrels ×2 |
| `/add-agy` | branche `providers` (origin) | provider agy (host + container) + tests + `docs/agy-provider.md` + lignes barrels ×2 |
| `/add-rtk` | `resources/` | plugin opencode `container/opencode-plugins/rtk.js` (le binaire + hook claude + timer d'update sont hors dépôt, voir le SKILL.md) |
| `/add-opencode-memory` | `resources/` | shim `container/opencode-plugins/opencode-claude-memory.js` + entrée `cli-tools.json` |
| `/add-vikunja` | `resources/` | serveur MCP `container/agent-runner/src/mcp-servers/vikunja/` |

Après toute modification d'un fichier skill-owned installé :
`pnpm exec tsx scripts/skills-sync.ts sync <skill>` (recommit la branche de
modules et/ou recopie les resources).

Après chaque `/update-nanoclaw` : `pnpm test` suffit à prouver que les six
skills restent fonctionnels/installables — y compris ceux qui ne seraient pas
installés (le test vérifie alors que leurs cibles d'édition existent encore).
La suite E2E (`tests/integration/mattermost/run_suite.py`) **skippe**
proprement les scénarios des skills absents (matrix opencode, provider
switch) et sort en SKIP global si l'adapter Mattermost n'est pas installé.

### Reliquat (statu quo : /update-nanoclaw + POST_UPDATE_CHECKLIST)

Les patchs **in-place** de fichiers upstream restent gérés par merge — les
convertir exigerait des points d'extension côté upstream (hooks) :

- `src/container-runner.ts` — mount OAuth Claude Pro (CLAUDE_PRO_AUTH.md),
  mount global rtk, injection env par groupe, durcissements build/kill
- `container/agent-runner/src/providers/claude.ts` — contexte 1M,
  live-status/progress (importe `summarize.ts` fourni par /add-opencode),
  abort dur, thinking
- `container/agent-runner/src/{poll-loop,formatter,…}.ts` — système
  background/bg-commands, live-status, corrections de la review 2026-07-01
- `src/{delivery,host-sweep,router,session-manager,…}.ts` — corrections de
  la review 2026-07-01 (deliver() lève, claim atomique approvals, etc.)
- `src/db/migrations/019+020` — colonnes env/thinking de container_configs
- `setup/`, `scripts/` (q.ts, reauth-google, refresh-claude-token),
  `migrate-v2.sh`, `.gitignore`, `CLAUDE.md`, `container/CLAUDE.md`

### Extension dashboard (2026-07-05 — 7 propositions santé/observabilité)

Le dashboard (`/add-dashboard`, skill upstream) est étendu côté fork, sans
PR upstream :

- **`src/dashboard-health.ts`** (nouveau, fork-owned) — checks de santé :
  expiry OAuth Claude + état des timers systemd (claude-token-refresh,
  nanoclaw-rtk-update, nanoclaw-upstream-watch), fichiers credentials MCP
  présents par groupe, token agy, OneCLI UI joignable, économies rtk
  (host + sessions), marqueur E2E, drift skills-sync (1×/h). Sorties :
  clé `health` du snapshot, lignes `[health]` dans la page Logs (sur
  changement d'état uniquement), et `data/health.json` en local.
  `collectSessionRuntime()` remonte aussi bg_jobs/live_enabled/continuations
  par session (clé `session_runtime`).
- **`src/dashboard-pusher.ts`** — ⚠️ fichier posé par le skill upstream
  /add-dashboard, PATCHÉ localement (bloc fork dans `push()` + import).
  Après un update du skill upstream, re-porter ce bloc (post-update
  checklist).
- **`container/agent-runner/src/{poll-loop,db/session-state}.ts`** —
  persistance observabilité des bg jobs (`session_state.bg_jobs`, écrite à
  chaque mutation + throttle 10 s pendant les live-updates, purgée au boot).
  S'ajoute au système bg du reliquat ci-dessus.
- **`tests/integration/mattermost/run_suite.py`** (skill-owned
  /add-mattermost, synchro branche `channels`) — écrit
  `logs/e2e-last-run.json` en fin de run pour le check e2e-last-run.
- **`src/dashboard-usage.ts`** (fork-owned, 2026-07-05) — stats tokens et
  fenêtres de contexte **OpenCode** (lecture des `opencode-xdg/opencode/
  opencode.db` par session, agrégats par modèle/groupe injectés dans les
  sections By Model / Context Windows de l'Overview ; plus récent par
  groupe seulement) + récap agents par channel (`data/agents-recap.md`,
  MCP actifs et droits d'accès dérivés de container_configs). Limitation
  documentée : agy/Antigravity n'expose aucun comptage de tokens.
  Trois retouches supplémentaires dans `dashboard-pusher.ts` (imports,
  entrées pré-agrégées `requests`, appel writeAgentsRecap).
- **`patches/@nanoco__nanoclaw-dashboard@0.3.0.patch`** (pnpm patch,
  2026-07-05) — page « Agents » ajoutée à l'UI du dashboard : entrée de nav,
  route `/dashboard/agents` (+ API `/api/agents-recap`), rendu du récap par
  channel (provider/modèle, déclenchement, MCP, droits en badges) et des
  checks santé. Réappliqué automatiquement à chaque `pnpm install` via
  `patchedDependencies` (pnpm-workspace.yaml). ⚠ Au bump de version du
  paquet, le patch doit être re-porté (`pnpm patch @nanoco/nanoclaw-dashboard@<ver>`).
  Données servies par les clés snapshot `agents_recap`/`health` (fork).

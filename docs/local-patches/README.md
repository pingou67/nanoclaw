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

### Provider codex — un patch porté EN AVANCE sur upstream (2026-08-03)

Installé via `/add-codex` (skill upstream, payload branche `providers`) pour le
groupe `testor-codex` (GPT-5.6 Terra, effort `medium`, compte ChatGPT Plus).
Trois écarts fork à connaître, tous nécessaires — le payload publié **ne
compile pas** contre `upstream/main` tel quel :

1. **`a6a46621` cherry-pické** (`fix(codex): deliver harness file events + add
   `file` to ProviderEvent`) — le provider codex émet `{type:'file'}` pour les
   images qu'il génère, événement qu'aucune branche `types.ts` ne déclare : le
   correctif vit dans `upstream/fix/codex-file-event`, **non mergé**. Il ajoute
   la variante à l'union, extrait `enqueueFileOut()` dans
   `container/agent-runner/src/outbox.ts` et fait livrer les fichiers par le
   poll-loop. ⚠️ **Nous portons donc du code en avance sur upstream** : au
   prochain merge qui intègre cette PR, attendre un conflit sur `poll-loop.ts`
   (notre `deliverToOrigin`/`deliverErrorResult` cohabite avec leur
   `deliverHarnessFile`) et garder les deux.
2. **`toCodexMcpServers()`** dans `container/agent-runner/src/providers/codex.ts`
   — notre `McpServerConfig.command` est optionnel (support des serveurs MCP
   **distants**, patch `e8808f2`), `CodexMcpServer.command` est requis. La
   fonction ne laisse passer que le stdio et **journalise nommément** chaque
   serveur distant écarté (un MCP droppé en silence nous avait coûté un long
   diagnostic sous kimi le 2026-07-28).
3. **Contexte de test** — `src/providers/codex-host-contribution.test.ts` reçoit
   `groupEnv` + `containerConfig`, requis par notre `ProviderContainerContext`
   et absents du payload upstream.

Écart de pin assumé : le SKILL.md épingle `@openai/codex` **0.146.0** au lieu
du `0.138.0` upstream, qui date du 2026-06-08 — un mois avant la GA de la
famille GPT-5.6 et donc incapable de sélectionner Terra. Justifié dans le
SKILL.md lui-même. La veille `scripts/supply-watch.ts` suit l'entrée
automatiquement (elle est dans `cli-tools.json`).

rtk : pas de hook natif possible (`rtk hook` parle claude/cursor/gemini/copilot/
droid, **pas codex**) — la consigne vit dans
`groups/mattermost_testor-codex/instructions.prepend.md`, que
`readGroupPersona` injecte en section *Persona* de l'`AGENTS.md` composé.

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
  nanoclaw-supply-watch — la veille unifiée qui a remplacé rtk-update /
  upstream-watch / cli-tools-watch le 2026-07-29), fichiers credentials MCP
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
- **Actions d'écriture du dashboard** (2026-07-05) — sous-ensemble borné
  piloté par `src/dashboard-actions.ts` (fork-owned, WHITELIST stricte :
  effort/model/thinking, restart de groupe, toggle live via injection de la
  commande `!live` en inbound — jamais env/mounts/cli_scope/rôles), étendue le 2026-07-05 aux tâches planifiées : job-add/update/pause/resume/cancel via les primitives du module scheduling sur l'inbound.db (host = écrivain légitime), validation cron 5 champs + échéance ISO + prompt ≤ 4000.
  Gardé par un token DÉDIÉ `DASHBOARD_WRITE_SECRET` (.env, non commité) —
  absent = dashboard strictement lecture seule ; le token lecture ne donne
  jamais l'écriture. Audit : chaque action (acceptée ou refusée) émet une
  ligne `[action]` dans les logs host, visible sur la page Logs du
  dashboard. Le patch pnpm ajoute POST /api/actions (401/403/413) et les
  contrôles UI sur la page Agents (token demandé au premier usage, stocké
  en localStorage du navigateur).

### Coffre Bitwarden — secrets hors HTTP (2026-07-30)

Doctrine complète dans `CLAUDE.md` § *Secrets / Credentials / OneCLI* ;
nuance ajoutée à `docs/SECURITY.md` §4, dont la garantie « aucun credential
n'entre dans un container » ne vaut que pour HTTP. Fichiers **fork-owned** :

- **`src/secrets/vault.ts`** (nouveau) — résout une valeur `vault:élément[/champ]`
  via `rbw`. Lève si la référence est illisible : **le spawn est refusé**,
  jamais démarré avec une variable vide dont l'échec surgirait ailleurs.
- **`src/secrets/imap-creds.ts`** (nouveau) — génère `{accounts.json,.key}`
  éphémère **par session** (clé aléatoire à chaque spawn), monté RO. Reproduit
  le format AES **non documenté** d'`imap-mcp-server` → à revérifier à chaque
  bump du paquet ; `imapCredsRoundTrip` + le scénario E2E `mcp imap @#work`
  sont les garde-fous.
- **`src/container-runner.ts`** — ⚠️ **l'ordre est load-bearing** : la
  résolution a lieu dans `spawnContainer`, APRÈS `materializeContainerJson`
  (le fichier ne doit contenir que des références) et AVANT
  `resolveProviderContribution` (la contribution opencode recopie `groupEnv` et
  écraserait la valeur résolue par la référence brute — symptôme distant et
  trompeur : « No credentials configured for opencode.ai »). Verrouillé par
  `src/secrets/spawn-order.test.ts`, dont un test interdit une SECONDE
  résolution, laquelle masquerait la régression.
- **`scripts/sync-vault-to-onecli.ts`** + **`scripts/vault-onecli-map.json`** —
  synchro one-way coffre → OneCLI pour les secrets en en-tête HTTP. Refuse de
  pousser vers un secret sans `injectionConfig` (piège CLI 2.2.5 : `secrets
  create --header-name` ne le pose pas, le secret existe alors sans jamais
  être injecté).
- **`scripts/check-secret-scope.ts`** — audit du périmètre (voir §S ci-dessous).

### Caviardage + cohérence d'état du dashboard (2026-07-30)

- **`src/dashboard-redact.ts`** (nouveau, fork-owned) — caviarde
  `container_config` avant publication. Le dashboard est servi sur `0.0.0.0`
  **en dur par le paquet upstream**, avec le jeton d'API dans un `<meta>` de la
  page `/dashboard` servie sans authentification : tout ce qui y est poussé est
  lisible du réseau local. Les URL sont réduites à leur origine (le jeton de
  `ha` vit dans le CHEMIN), en-têtes et valeurs sous clé sensible masqués ; les
  DÉSIGNATIONS (`vault:…`, `onecli-injected`) restent lisibles à dessein.
- **`src/dashboard-health.ts`** — `containerPathToHost` résout aussi les
  chemins servis par un mount. Ne traiter que `/workspace/agent/…` laissait 12
  des 14 credentials MCP hors surveillance **en silence**, le contrôle restant
  vert.
- **`src/session-manager.ts` + `src/index.ts`** — `reconcileContainerStatusOnBoot()`
  après `cleanupOrphans()`. `container_status` ne repasse à `stopped` que sur
  l'événement `close` du processus enfant, jamais émis si l'hôte s'arrête : 37
  sessions fantômes s'étaient accumulées, et `getRunningSessions()` pilote
  `pollActive` **à 1 s**. ⚠️ `getActiveSessions()` filtre sur `status='active'`
  (notion de session), PAS sur `container_status`.

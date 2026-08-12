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
| `/add-vikunja` | `resources/` | serveur MCP `container/agent-runner/src/mcp-servers/vikunja/` |

Après toute modification d'un fichier skill-owned installé :
`pnpm exec tsx scripts/skills-sync.ts sync <skill>` (recommit la branche de
modules et/ou recopie les resources).

Après chaque `/update-nanoclaw` : `pnpm test` suffit à prouver que les quatre
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
2. **Serveurs MCP distants — `CodexMcpServer` élargi + `toCodexMcpServers()`.**
   `CodexMcpServer` est une union stdio | distant, et `writeCodexConfigToml`
   émet la forme correspondante (`url` + `bearer_token_env_var` optionnel) —
   forme obtenue en faisant écrire codex lui-même sous 0.146, pas déduite d'une
   doc. ⚠️ **Ne pas répéter l'erreur de diagnostic du 2026-08-03** : le support
   des MCP distants n'a jamais manqué à codex, c'est notre payload qui ne le
   modélisait pas. Tests : `codex-mcp-shapes.test.ts` (conversion),
   `codex-app-server.test.ts` (forme TOML).

   **Notre patch `e8808f2` est RETIRÉ depuis le merge du 2026-08-11** : upstream
   a implémenté les MCP distants (`99cc8662`) avec une union discriminée
   `McpStdioServerConfig | McpHttpServerConfig`, plus stricte que notre type
   permissif. Vérifié avant de basculer : `headers` et `type: 'sse'`
   disparaissent du modèle, nous n'en avions aucun usage (`ha` est en `'http'`
   sans en-tête). Quatre convertisseurs réalignés sur la discrimination par
   `type` — claude, agy, opencode, codex.

   ⚠️ Deux conséquences de cette adoption :
   - **`ha` est ACQUIS mais plus ré-enregistrable.** `parseMcpServerConfig`
     impose HTTPS hors loopback ; notre `http://192.168.1.113:9583/…` serait
     refusé. Il fonctionne car la LECTURE au spawn ne valide pas (`JSON.parse`
     nu) — seuls les chemins d'écriture (ncl, self-mod, templates) valident.
     Le ré-ajouter par `ncl groups config add-mcp-server` échouerait.
   - **Les deux gardes de rejet de `toCodexMcpServers` sont devenus
     inatteignables** (« ni command ni url », « en-têtes personnalisés ») : le
     typage interdit désormais ces formes. Leurs tests ont été retirés avec
     eux. Si `headers` revenait côté cœur, **rétablir le rejet NOMMÉ sur
     stderr en même temps que le champ** — un MCP droppé en silence ne se voit
     que par des outils absents (diagnostic coûteux sous kimi, 2026-07-28).
3. **Contexte de test** — `src/providers/codex-host-contribution.test.ts` reçoit
   `groupEnv` + `containerConfig`, requis par notre `ProviderContainerContext`
   et absents du payload upstream.
4. **Palier d'effort `max`** (2026-08-03) — introduit par la famille GPT-5.6
   (GA 2026-07-09), au-dessus de `xhigh`. Absent du payload, épinglé sur
   codex-cli 0.138.0 publiée un mois plus tôt. Ajouté à `CodexReasoningEffort`
   et à `SUPPORTED_EFFORTS`. ⚠️ **`codex.factory.test.ts` affirmait l'inverse**
   (« rejects … `max` ») : le test est inversé chez nous, attendre un conflit
   à cet endroit le jour où upstream bump son pin. `adaptive`, lui, reste
   refusé — codex n'a **pas** d'effort adaptatif, c'est un palier fixe pour
   tous les tours, sans équivalent du `thinking: {type:'adaptive'}` de claude
   (que le provider codex ne lit pas du tout).

Écart de pin assumé : le SKILL.md épingle `@openai/codex` **0.146.0** au lieu
du `0.138.0` upstream, qui date du 2026-06-08 — un mois avant la GA de la
famille GPT-5.6 et donc incapable de sélectionner Terra. Justifié dans le
SKILL.md lui-même. La veille `scripts/supply-watch.ts` suit l'entrée
automatiquement (elle est dans `cli-tools.json`).

rtk a été RETIRÉ de toute l'installation le 2026-08-12 (voir la section
suivante) : c'est précisément l'absence de `rtk hook codex` qui a rendu la
compression incohérente à travers la flotte.

### Bascule de 6 groupes claude → codex (2026-08-12) — deux pannes muettes

`adminsys`, `coding`, `famille`, `work`, `work-ei` et `dm` sont passés en
`codex` / `gpt-5.6-terra` / effort `medium`. La bascule a révélé deux défauts
que `testor-codex` ne pouvait pas exposer, parce qu'un groupe **créé
directement** sur codex ne suit pas le même chemin qu'un groupe **migré**
depuis claude. Les deux échouent en silence — c'est ce qui les rend coûteux.

1. **`materializeTemplateSkills` plantait tout spawn d'un groupe migré**
   (`src/group-skills.ts`). Le `.claude-shared/skills/` d'un groupe claude ne
   contient que des liens symboliques vers `/app/skills/<nom>` — des chemins
   *container*, qui pendent côté hôte. Le `statSync` suivait le lien → ENOENT
   → l'exception remontait jusqu'à `spawnContainer`. Résultat :
   `wakeContainer failed`, host-sweep relance le même spawn toutes les 60 s
   **indéfiniment**, et le groupe reste muet sans rien afficher à l'utilisateur.
   Corrigé en `readdirSync(..., {withFileTypes:true})` (sémantique lstat, un
   lien n'est jamais un répertoire). Un groupe né sur codex n'a pas ce dossier,
   d'où l'angle mort. Test : `src/group-skills.test.ts`.

2. **Les serveurs MCP lancés par codex perdaient le proxy OneCLI**
   (`container/agent-runner/src/providers/codex.ts`). Le bloc `env` d'un
   serveur stdio **remplace** l'environnement au lieu de l'étendre : sans
   `HTTP(S)_PROXY` ni `NODE_EXTRA_CA_CERTS`, le serveur sort du périmètre de la
   passerelle. Celui dont le secret est injecté dans un **en-tête** prend alors
   un 401, plante au démarrage, et codex l'écarte — la panne ne se voit que par
   des outils absents. `vikunja` était donc muet sur `dm`/`famille`/`work`, et
   **sur `testor-codex` depuis son installation le 2026-08-03** sans que rien ne
   le signale. `toCodexMcpServers` réinjecte désormais les variables réseau
   (l'`env` déclaré du groupe garde le dernier mot) ; les serveurs distants ne
   sont pas concernés, codex ouvre lui-même la connexion. Tests :
   `codex-mcp-shapes.test.ts`.

   ⚠️ Ce défaut ne touche QUE les secrets livrés par injection d'en-tête. Les
   serveurs à OAuth sur fichier (gmail, google-calendar) ou à référence de
   coffre (imap) fonctionnaient — d'où une panne isolée, facile à prendre pour
   une lubie du modèle plutôt que pour un défaut de configuration.

**rtk a été retiré de toute l'installation dans la foulée (2026-08-12).** La
compression passait par le hook `PreToolUse` de Claude Code, et `rtk hook` ne
parle pas codex : après la bascule elle n'aurait plus couvert qu'une minorité
de groupes, les autres devant porter une consigne en clair coûteuse en
contexte. Plutôt qu'un demi-dispositif, suppression complète — montage
`container-runner`, hook des 11 `settings.json`, plugin opencode, règles agy,
consigne codex, skill `/add-rtk`, `scripts/apply-rtk-update.sh`, origine
`host-binary` de la veille et mesure `rtk-savings` du tableau de bord.

⚠️ Le binaire `~/.local/bin/rtk` **reste sur l'hôte** — il sert les sessions
Claude Code de l'opérateur (`RTK.md` global), sans rapport avec nanoclaw. Sa
version n'est donc plus surveillée par `supply-watch`. Le seam de plugins
opencode est conservé : recréer `container/opencode-plugins/` suffit à le
réactiver.

Le périmètre OneCLI a suivi la bascule : le secret `Codex` a été accordé aux 6
agents (`agents set-secrets`, mode `selective` conservé), en union avec
`Vikunja` là où le serveur MCP le justifie — jamais par symétrie.

### OneCLI — ce que `docs/onecli-upgrades.md` ne dit pas de CETTE installation (2026-08-03)

Trois écarts constatés en appliquant le doc upstream. Les connaître évite de
lancer une migration de passerelle qui n'avait pas lieu d'être.

1. **La passerelle est en AVANCE sur le pin, pas en retard.** L'image qui
   tourne est `ghcr.io/onecli/onecli:latest`, étiquetée **v1.37.0**, au-dessus
   du `onecli-gateway: 1.36.0` de `versions.json`. Ne pas « corriger » ça : ce
   serait un downgrade. Vérifier avec
   `docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' onecli-app-1`.
2. **`onecli version` renvoie la version du CLI, pas de la passerelle.** Le
   `1.1.0` qu'il affichait était le binaire hôte, face au pin
   `onecli-cli: 2.2.5` — c'était le seul vrai écart. Le CLI est *stateless*
   (le coffre vit dans la passerelle) : le remplacer ne perd rien, et c'est
   sans commune mesure avec une migration de passerelle.
3. **Notre `~/.onecli/docker-compose.yml` date de mars et diffère du doc** : le
   service s'appelle `app` (pas `onecli`) et l'image est figée sur `latest`
   sans variable `${ONECLI_VERSION}`. La commande
   `ONECLI_VERSION=… docker compose pull onecli` du doc **ne s'applique pas
   telle quelle** — il faudrait d'abord paramétrer le tag.

**Rupture de format à retenir.** Le CLI a changé de sortie entre majeures :
1.x rendait un tableau nu, 2.x rend `{ "hint": …, "data": [...] }`. La montée
a cassé d'un coup `check-secret-scope.ts` et `sync-vault-to-onecli.ts`.
`scripts/onecli-cli.ts` (+ son test) absorbe désormais les deux formes et
**lève** sur une troisième — parce qu'un audit qui rend une liste vide conclut
« conforme » au lieu de « je n'ai rien pu lire ».

**Durcissement Postgres (même date).** `~/.onecli/docker-compose.yml` publiait
`5432` sur `0.0.0.0` avec le mot de passe par défaut `onecli/onecli` : la base
du coffre à credentials était joignable depuis tout le LAN. La publication est
restreinte au loopback (`127.0.0.1:5432`), l'application joignant Postgres par
le réseau compose. Sauvegarde du fichier d'origine à côté, en
`docker-compose.yml.bak-*`. ⚠️ **Reste à faire** : le mot de passe est toujours
`onecli` — défense en profondeur seulement, désormais, mais à changer (il faut
`ALTER USER` + `DATABASE_URL` dans le même mouvement).

### Image de base re-tirée à chaque build, et pourquoi pas l'image durcie (2026-08-07)

**Patch : `--pull` dans `container/build.sh`.** Sans lui, docker réutilise
indéfiniment le `node:22-slim` présent localement. Le nôtre avait **quatre
mois** : chaque rebuild remontait fidèlement nos versions npm en laissant la
Debian dessous inchangée, correctifs de sécurité compris. `NANOCLAW_NO_PULL_BASE=true`
pour construire hors ligne.

**Pourquoi on ne bascule PAS sur l'image durcie** (question posée le 2026-08-07,
étude faite, décision : non pour l'instant) :

1. **Le verrou `bun.lock` interdit le chemin `pull`.** L'image porte le label
   `dev.nanoclaw.agent-runner-lock-sha256` ; `build.sh` le compare au
   `container/agent-runner/bun.lock` du checkout et **refuse** en cas d'écart
   (lignes ~74-96). Notre lock est celui du fork et bouge à chaque bump de dep
   agent-runner — une image publiée contre un autre lock sera toujours rejetée.
2. **Nos providers ne sont pas dedans.** La doc est explicite : « Non-Claude
   providers: only if the publisher baked the CLI, or you add it ». opencode,
   codex et agy sont à nous, plus les 8 entrées de `cli-tools.json`.
3. **Les images dérivées sont par groupe et effacées au refresh** — le
   mécanisme `install_packages` construit bien `FROM ${CONTAINER_IMAGE}`
   (`src/container-runner.ts:723`), mais « a refresh clears these pins ».

La variante *« `FROM <durcie>` dans NOTRE Dockerfile, en construisant
localement »* échapperait aux points 1 et 3 — c'est une ligne à changer. Elle
reste non évaluée : il faudrait d'abord tirer l'image (compte NanoClaw, adresse
e-mail collectée, ~800 Mo depuis us-east-1), et son contenu recoupe largement ce
que notre Dockerfile installe déjà. À rouvrir si la fraîcheur de Chromium
devient un sujet — c'est `agent-browser` qui le pilote.

### Reliquat (statu quo : /update-nanoclaw + POST_UPDATE_CHECKLIST)

Les patchs **in-place** de fichiers upstream restent gérés par merge — les
convertir exigerait des points d'extension côté upstream (hooks) :

- `src/container-runner.ts` — mount OAuth Claude Pro (CLAUDE_PRO_AUTH.md),
  injection env par groupe, durcissements build/kill
- `container/agent-runner/src/providers/claude.ts` — contexte 1M,
  live-status/progress (importe `summarize.ts` fourni par /add-opencode),
  abort dur, thinking
- `container/agent-runner/src/{poll-loop,formatter,…}.ts` — système
  background/bg-commands, live-status, corrections de la review 2026-07-01.
  **Deux résolutions du merge 2026-08-11 à reproduire si elles reconflictent :**
  (a) `formatter.ts` — upstream et nous avions corrigé le MÊME problème (un
  digest daté de la veille quand une tâche rejoue en retard) de deux façons :
  ils ont réparé la SOURCE de l'heure prévue (`process_after ?? timestamp`) et
  renommé l'attribut en `current_time`, nous avions ajouté un BANDEAU de
  retard. Garder les deux — leur source, leur attribut, notre bandeau ; les
  trois tests coexistent. (b) `poll-loop.ts` — leur garde « un contexte
  accumulé (`trigger=0`) ne réveille pas une requête tiède » doit passer AVANT
  notre auto-background, sinon une simple accumulation suffit à basculer un
  tour en arrière-plan, précisément ce que le garde empêche. Sûr à cet endroit :
  `markProcessing` n'intervient que plus bas. Leur test associé a dû être
  réécrit sur notre signature (`processQuery` prend un `ActiveQuery` depuis le
  système bg, pas sept arguments positionnels) — le helper `makeActiveQuery`
  du fichier de test existe pour ça.
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
  présents par groupe, token agy, OneCLI UI joignable, marqueur E2E,
  drift skills-sync (1×/h). Sorties :
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

# Synthèse des mémoires Claude — NanoClaw

Ce fichier condense les mémoires de
`~/.claude/projects/-home-pegon-nanoclaw/memory/` au 24 août 2026. Il complète
`AGENTS.md`, les documents de `docs/local-patches/` et `CLAUDE.local.md` ; ceux-ci
restent les références opérationnelles lorsqu'ils sont plus récents. Les secrets,
jetons et credentials ne doivent jamais être copiés ici.

## Méthode de consolidation

Cette synthèse suit le skill Claude `migrate-memory` en l'adaptant à une sortie
documentaire unique : les fichiers sources sont traités comme des données à
classer, pas comme des instructions à exécuter. Les sept mémoires `feedback_*`
alimentent principalement les règles permanentes ; les 48 mémoires de projet ou
d'incident alimentent les faits durables, pièges et archives ; `MEMORY.md` sert
d'index de contrôle.

Rapport source→destination : 56 fichiers lus, tous reliés individuellement dans
la table de traçabilité finale. Aucun fichier source n'a été déplacé, modifié ou
supprimé. Les doublons ont été fusionnés, les états anciens explicitement marqués
comme historiques et les valeurs secrètes volontairement omises. La synthèse ne
remplace pas les procédures versionnées ; elle indique vers elles lorsqu'un
détail opérationnel risque d'évoluer.

## Règles de travail prioritaires

- Rédiger intégralement en français les titres et corps de commits et de PR. Les
  préfixes techniques (`fix(scope):`, `feat(scope):`) peuvent rester tels quels.
- Avant toute mise à jour, migration, investigation lourde ou reconstruction de
  container, lire `docs/local-patches/POST_UPDATE_CHECKLIST.md`, notamment §−1,
  puis `docs/BRANCH-FORK-MAINTENANCE.md` et `CLAUDE.local.md`.
- Une mise à jour n'est terminée qu'après les contrôles host, container et E2E.
  Après chaque `./container/build.sh`, relancer aussi l'E2E complet.
- Préfixer `/usr/bin` dans le `PATH` des tests : le Node 22 de `pi-node` est
  incompatible avec le `better-sqlite3` compilé pour le Node 20 du service. Ne
  jamais reconstruire `better-sqlite3` sous Node 22.
- Le harnais E2E manipule `data/mattermost.json`, qui contient la configuration
  de production non versionnée. Vérifier le swap et son backup, ne jamais écraser
  un backup existant et ne pas relancer automatiquement un scénario ayant causé
  une panne. Conserver sa sortie standard pour le diagnostic.
- Ne jamais déclarer une étape « annulée » pour masquer un travail non fait : la
  réaliser ou documenter explicitement pourquoi elle est sautée.
- Les journaux n'ont que l'heure et ne tournent pas. Ne pas attribuer une ligne à
  la journée courante sur cette seule base ; s'ancrer sur les identifiants à
  timestamp. `channelId=ch-*` désigne le mock E2E, un ID de 26 caractères le vrai
  Mattermost.

## État actuel de l'installation

- NanoClaw est en v2. La migration initiale date du 26 avril 2026 ; l'ancien
  modèle v1, ses bots autonomes et ses conventions IPC ne sont plus actifs.
- La grosse migration du 19 août a intégré 112 commits upstream et le seam de
  runtime/DB centrale asynchrone. Validation alors obtenue : host 1954/1954,
  container 451/451, E2E 28/28.
- La DB centrale `data/v2.db`, via l'interface asynchrone `DbDriver`, est la
  source de vérité pour les groupes et `container_configs`. Les fichiers
  `groups/<folder>/container.json` sont des matérialisations au spawn, pas une
  source à modifier.
- Les DB de session restent synchrones et séparées : `inbound.db` est écrite par
  l'hôte, `outbound.db` par le container. Ne pas convertir mécaniquement ce code
  vers le driver async.
- La mémoire des groupes est l'arbre OKF provider-agnostic (`memory/` et
  `instructions.prepend.md`). L'ancien serveur MCP memory et son plugin container
  ont été supprimés. Le plugin mémoire de l'OpenCode de l'opérateur est distinct
  et peut toujours partager ce dossier de mémoires Claude.
- Discord, DDG MCP, OpenRouter historique, Kimi et RTK dans les containers sont
  retirés. Le binaire RTK de l'opérateur peut encore exister, mais NanoClaw ne le
  monte ni ne le surveille.
- Le DM Mattermost valide de Philippe est `dm-oxwrkxxc` ; les anciens DMs ont été
  purgés. Utiliser des liens Markdown `[libellé](url)`, cliquables sans preview,
  plutôt que des URL en code inline.

## Providers et groupes

État mémorisé depuis le 12 août 2026 :

- `dm`, `famille`, `work`, `work-ei`, `adminsys`, `coding` et `testor-codex` :
  Codex, modèle `gpt-5.6-terra`, effort `medium`.
- `testor-claude` et `globalbuilder` : Claude/Opus ; `e2e_switch` : Claude/Sonnet.
- `testor` uniquement : OpenCode. Ne jamais le traiter comme un container Claude.
- `testor-agy` : provider `agy`/Gemini.

Une migration de provider doit préserver les réglages utiles au rollback et
purger la continuation du provider quitté si elle provoque des erreurs de modèle.
Avant toute nouvelle bascule, relire la documentation locale : celle du 12 août a
révélé deux pannes silencieuses, des symlinks Claude inspectés pour Codex et un
environnement OneCLI remplacé au lieu d'être fusionné.

### Codex

- Le fork porte le support des événements fichier en avance sur l'ancien payload
  upstream. Lors d'un conflit dans `poll-loop.ts`, conserver à la fois
  `deliverErrorResult` et `deliverHarnessFile` tant que l'amont ne les subsume pas.
- Codex sait utiliser les MCP distants (`url` dans `config.toml`). Il ne sait pas
  exprimer des en-têtes arbitraires, seulement `bearer_token_env_var`; un serveur
  incompatible doit être écarté en étant nommé sur stderr.
- L'auth Codex moderne utilise le trousseau par défaut. Dans un container, forcer
  `auth_credentials_store_mode=file` lors du login temporaire, avec le bon UID.
  Le chemin sanctionné est `scripts/codex-vault-login.sh`; le fichier de groupe
  doit rester vide lorsque OneCLI injecte le credential à la requête.
- Un statut de thread est de l'activité, pas une action. Seuls les vrais outils
  génèrent des événements `progress`, sinon le compteur d'actions ment.
- L'erreur `Reconnecting… Read-only file system` peut masquer un 401
  `token_expired`. Vérifier les logs de la passerelle et le refresh OAuth avant
  d'accuser les mounts.

### Claude

- L'auth par abonnement vient du fichier OAuth de `~/.claude-anthropic`, monté
  en lecture seule dans `/home/node/.claude/.credentials.json`. Le code doit
  sonder `CLAUDE_CONFIG_DIR`, puis `~/.claude-anthropic`, puis `~/.claude`.
- La présence du mount impose de neutraliser les placeholders API/proxy OneCLI.
  Le mount est de classe `allowlisted-extra`, pas `identity-material`.
- Les connecteurs claude.ai (`mcp__claude_ai_*`) sont interdits via
  `disallowedTools`; `disableClaudeAiConnectors` n'était pas respecté en headless.
  Ne pas se fier à la seule liste MCP d'initialisation, car ces outils sont
  différés.
- Le timer de refresh OAuth et le mount sont une paire. Un 401 mentionnant
  OneCLI peut seulement signifier que le credential OAuth monté est expiré.

### OpenCode et agy

- OpenCode utilise une souscription SSE par requête afin que foreground et
  background ne se volent pas les événements. Les outils sont dédupliqués par
  `callID`; les statuts de vivacité ne comptent pas comme actions.
- Si OpenCode boucle sur `OpenCode event timeout` et reste en typing, tuer le
  container puis vérifier `continuation:opencode`. Le correctif conceptuel est
  de borner le timer au tour actif.
- Un `session.idle` peut arriver entre plusieurs messages assistant. Le provider
  conserve le dernier message vu, mais un message produit après l'idle peut
  encore être perdu : comparer l'API de session et `outbound.db`.
- Agy dispose de sa propre compaction interne opaque. Le plan de rotation de
  continuation externe n'a jamais été implémenté.

## Secrets, coffre et OneCLI

Bitwarden/Vaultwarden est l'unique source de vérité. Appliquer le moindre
privilège : un groupe ne reçoit un secret que si un besoin fonctionnel nommé le
justifie.

- Secret transporté dans un en-tête HTTP : OneCLI le réécrit à la requête ; le
  container ne voit qu'un marqueur tel que `onecli-injected`.
- Tout autre secret : référence `vault:élément[/champ]` résolue côté hôte au
  spawn. Une référence illisible doit faire échouer le spawn, jamais produire
  une valeur vide.
- La résolution `vault:` se fait après `materializeContainerJson` et avant
  `resolveProviderContribution`; l'ordre inverse réintroduit la référence brute.
- Les credentials IMAP sont générés de façon éphémère par session et montés RO.
  Aucun `~/.imap-mcp` permanent ne doit être recréé.
- `container.json` doit être en 0600. Les logs MCP distants n'impriment que
  l'origine, jamais une URL complète susceptible de porter un jeton.
- La traduction des IDs OneCLI underscore→tiret vit dans
  `src/gateway-providers/onecli.ts`. Sa perte recrée des agents en mode `all` et
  détruit silencieusement le périmètre des secrets.
- Depuis la passerelle 1.45, les anciennes commandes `agents secrets` et
  `set-secrets` sont retirées au profit des grants. En conséquence,
  `scripts/check-secret-scope.ts` est obsolète tant qu'il n'est pas réécrit avec
  les endpoints de grants. Ne pas prendre son échec ou son silence pour un audit
  valide.
- La passerelle est épinglée en 1.45.0 pour inclure le correctif de refresh OAuth
  OpenAI avec `client_id`. Elle n'est pas surveillée automatiquement.
- Le CLI OneCLI et la passerelle ont des versions indépendantes. Le parseur local
  doit accepter les sorties tableau 1.x et `{hint,data}` 2.x, mais lever sur une
  forme inconnue.
- Postgres OneCLI doit rester lié au loopback. Le mot de passe historique par
  défaut constitue encore une dette de défense en profondeur.
- `OPENCODE_API_KEY` passe par OneCLI avec l'hôte d'injection `opencode.ai`, pas
  `models.opencode.ai`. Aucun secret `sk-` ou `tk_` ne doit apparaître en DB.

Les tokens inclus dans le chemin d'une URL, comme le MCP Home Assistant, ne
peuvent pas être protégés par une réécriture d'en-tête. Réduire alors le nombre
de groupes exposés et redoubler de prudence dans les logs et le dashboard.

## Mattermost, dashboard et livraison

- L'adapter Mattermost est natif, en processus, avec WebSocket, rattrapage après
  reconnexion, threads, pièces jointes et statuts live. `deliver()` doit lever en
  cas d'échec pour activer les retries.
- Le `root_id` reste valable pour tous les posts d'un même tour et n'est réinitialisé
  qu'au message entrant suivant.
- `!clear` et les autres commandes sont des correspondances exactes et passent
  par le gate admin. Mattermost intercepte les commandes `/`, donc les commandes
  runner utilisent `!`.
- Une ligne historique ajoutée à `messages_out` sans ligne `delivered` associée
  sera repostée. Pour un import d'archive, ignorer les sorties ou insérer les
  marqueurs `delivered` dans la même transaction.
- `unknown_sender_policy: public` est permissif. Il convient au contexte privé
  actuel, mais doit être réévalué avant d'ouvrir un canal à des tiers.
- Le dashboard écoute historiquement sur `0.0.0.0`, sert une page non authentifiée
  contenant son token et rend donc ses données lisibles sur le LAN. Tout payload
  publié doit être caviardé ; le contenu des conversations reste sensible.
- `getRunningSessions()` et `getActiveSessions()` ne mesurent pas la même chose.
  Réconcilier les statuts de containers au boot avant l'adoption, sinon les
  sessions fantômes font tourner le poller à 1 seconde.

## Containers, MCP et chaîne d'approvisionnement

- Invariant : un démarrage de container ne télécharge rien. Les CLI et serveurs
  MCP npm sont épinglés dans `container/cli-tools.json` et appelés par leur bin ;
  jamais `npx -y`. Exceptions : serveur MCP réellement distant et Vikunja lancé
  depuis son arbre monté.
- Pour une dépendance runtime de l'agent-runner, modifier `package.json`, exécuter
  `bun install` dans `container/agent-runner`, puis versionner `bun.lock`. Les
  tests de cet arbre utilisent `bun:test`.
- Les paramètres nommés `bun:sqlite` gardent le préfixe `$` dans le SQL et dans
  les clés JavaScript.
- L'image est reconstruite avec sa base actualisée (`--pull`), sauf demande
  explicite hors ligne. Le cache BuildKit peut conserver des `COPY` périmés ; un
  vrai rebuild propre peut nécessiter de purger le builder.
- `scripts/supply-watch.ts` est l'unique veille quotidienne : pins de l'image,
  dépendances runtime, pins host exacts et dérive upstream. Elle ne met jamais à
  jour automatiquement et n'annonce qu'une version âgée d'au moins trois jours.
- Respecter `scripts/supply-holds.json`. Ne jamais ajouter un
  `minimumReleaseAgeExclude` ou `onlyBuiltDependencies` sans accord humain.
- `better-sqlite3` doit rester sous la majeure 13 tant que l'hôte tourne sous
  Node 20. Les versions de `chat` et `@chat-adapter/*` évoluent ensemble.
- RTK n'est plus monté dans les containers ni couvert par supply-watch. Ne pas
  réintroduire ses anciens scripts d'auto-update.
- Pour Vikunja, la source canonique est `~/DEV/mcp-vikunja` : corriger, committer
  et pousser depuis l'hôte NanoClaw, puis reporter dans NanoClaw et synchroniser
  le skill `add-vikunja`.

## Mises à jour, migrations et skills

- La copie installée des fichiers skill-owned est canonique. Après toute
  modification, lancer `scripts/skills-sync.ts sync <skill>`, puis
  `scripts/skills-sync.ts check`.
- Quand upstream implémente un patch local, comparer les capacités et abandonner
  le patch si le modèle upstream couvre réellement les usages. C'est ce qui a
  été fait pour les MCP distants en août.
- Pour une résolution massive, repartir du fichier upstream puis reposer chaque
  intention locale avec ses tests. Ne pas recoller de grands blocs devenus
  structurellement différents.
- Le détecteur de migration driver ne scanne que TypeScript. Inspecter aussi les
  scripts Python E2E et les filtres Docker.
- Les migrations DB locales doivent rester portables ; le test de portabilité
  analyse même les commentaires. Les alias appartiennent à nos migrations, les
  ancres d'import gardent le nom upstream.
- Le marqueur d'upgrade v2.2 enregistre commit et arbre. Le poser après le tout
  dernier commit, bump et formatage compris, sinon l'E2E échoue avec un message
  WebSocket trompeur.
- Les anciens re-ports par reset ont perdu du code local. Toujours comparer au
  tag pré-migration et appliquer l'intégralité de la checklist locale.

## Tâches de fond et robustesse du runner

- Le runner supporte un foreground et plusieurs backgrounds. `!background` ou
  l'auto-bg démote le tour ; son résultat final est posté puis injecté dans le
  prochain foreground. `!stop` doit réellement aborter le provider.
- La garde « contexte accumulé seul ne réveille pas une requête tiède » doit
  s'exécuter avant l'auto-background.
- Les ticks de rafraîchissement du live status ne sont pas des actions. Les
  statuts live sont indexés par message sortant pour éviter les nettoyages croisés
  entre foreground et backgrounds.
- Les écritures concurrentes de séquence doivent conserver leur atomicité et la
  parité host/container. Le heartbeat reste un touch de fichier.
- `killContainer` doit tuer le container Docker, pas seulement le client CLI, et
  exécuter `onExit` même si le container est déjà mort.

## Historique utile mais non prescriptif

- La migration v2 initiale, le bot Mattermost v1, les patches agent-runner v1,
  Discord, OpenRouter et DDG sont archivés. Ne pas restaurer leurs instructions
  dans le système actif sans décision explicite.
- L'ancien setup IMAP « work uniquement » et les règles `HOME`/cache pour `npx`
  sont remplacés par les credentials éphémères et les MCP cuits dans l'image.
- Les credentials Google Gmail/Calendar sont volontairement partagés entre les
  groupes documentés ; l'application OAuth doit rester en Production pour éviter
  l'expiration des refresh tokens au bout de sept jours. `famille` utilise son
  propre refresh token. `testor` possède Gmail, Calendar et IMAP volontairement.
- Home Assistant utilise le MCP distant `ha-mcp`. Son ancienne configuration HTTP
  sur IP privée est acquise mais peut être refusée à une nouvelle écriture par la
  validation HTTPS upstream. Ne pas supprimer une config fonctionnelle sans plan
  de réenregistrement.
- La police CJK n'est pas installée par défaut dans l'image. Ne proposer son
  activation que si le besoin de rendu CJK est réel.

## Traçabilité des mémoires sources

Chaque fichier source est représenté ci-dessous ; les détails obsolètes ont été
ramenés à leur leçon durable.

| Fichier | Synthèse / statut |
|---|---|
| `MEMORY.md` | Index général, absorbé dans les sections ci-dessus. |
| `feedback_commits_francais.md` | Commits et PR entièrement en français. |
| `feedback_e2e_harness_prod_config_danger.md` | Le swap Mattermost E2E peut détruire la config prod. |
| `feedback_ha_rest_api.md` | HA passe par `ha-mcp`; l'ancien secours REST est supprimé. |
| `feedback_mcp_npx_home_override.md` | Historique `npx`; remplacé par les outils cuits dans l'image. |
| `feedback_mcp_vikunja_depot.md` | `~/DEV/mcp-vikunja` est la source canonique. |
| `feedback_testor_not_claude.md` | `testor` est OpenCode, pas Claude. |
| `feedback_todo_cancelled_misuse.md` | Ne pas masquer un travail non fait par « cancelled ». |
| `project-update-2-1-54.md` | Ancres rollback, image durcie et pièges de merge historiques. |
| `project_agent_runner_changes.md` | Patches v1 dépréciés. |
| `project_agy_compaction_design.md` | Plan de compaction agy non implémenté. |
| `project_agy_provider.md` | Provider agy actif sur `testor-agy`. |
| `project_background_tasks.md` | Architecture foreground/background et auto-bg. |
| `project_bascule_codex_flotte.md` | Bascule prod Codex et deux pannes silencieuses. |
| `project_claude_ai_connectors_block.md` | Connecteurs claude.ai bloqués via outils interdits. |
| `project_claude_pro_auth.md` | Mount OAuth Claude et timer de refresh. |
| `project_codex_provider.md` | Payload Codex fork, MCP distant, auth et événements. |
| `project_codex_token_expire.md` | Panne refresh résolue par gateway 1.45.0. |
| `project_container_config_db.md` | `container_configs` en DB est la source de vérité. |
| `project_dashboard_drift.md` | Caviardage, exposition LAN et sessions fantômes. |
| `project_ddg_mcp.md` | DDG supprimé; recherche native selon provider. |
| `project_discord_archived.md` | Discord archivé et absent du système actif. |
| `project_driver_seam_migration.md` | Migration async/driver du 19 août et pièges majeurs. |
| `project_fleet_opencode.md` | Carte actuelle des providers. |
| `project_fork_skills_conversion.md` | Modèle skills, branches miroir et `skills-sync`. |
| `project_full_code_review_fixes_20260701.md` | Invariants de livraison, abort, approvals et runner. |
| `project_google_mcp_oauth.md` | OAuth Google en Production et réauth headless. |
| `project_google_mcp_shared_creds.md` | Mount Google partagé volontairement, token famille distinct. |
| `project_imap_mcp_work.md` | Ancien modèle IMAP, désormais remplacé. |
| `project_imap_minimax_loop.md` | Historique de boucles IMAP sous minimax. |
| `project_kimi_provider.md` | Kimi retiré; réinstallation seulement via décision explicite. |
| `project_logs_sans_date.md` | Logs sans date : corréler par identifiants. |
| `project_mattermost_bot.md` | Bot standalone v1 déprécié. |
| `project_mattermost_v2_adapter.md` | Adapter natif v2 et couverture E2E. |
| `project_mattermost_v2_followups.md` | DM valide, imports historiques et politique sender. |
| `project_mcp_servers_baked_image.md` | Aucun téléchargement MCP au spawn. |
| `project_merge_upstream_20260811.md` | MCP distant upstream et ordres de garde à préserver. |
| `project_migration_2119_report_gap.md` | Re-port lossy; toujours comparer et valider. |
| `project_node22_pinode_path.md` | Node 22 casse l'ABI `better-sqlite3`. |
| `project_okf_memory_pending.md` | Migration OKF achevée; ancien MCP memory supprimé. |
| `project_onecli_cli_2_2_5.md` | CLI/gateway distincts, formats 1.x/2.x et sécurité Postgres. |
| `project_onecli_v2_compat.md` | Traduction underscore→tiret obligatoire. |
| `project_opencode_claude_memory_plugin.md` | Plugin mémoire de l'OpenCode opérateur, distinct du container. |
| `project_opencode_event_timeout_loop_bug.md` | Timeout OpenCode et mitigation par respawn. |
| `project_opencode_live_status.md` | Progress outils OpenCode et déduplication. |
| `project_opencode_multimessage_truncation.md` | Dernier message assistant et limite après idle. |
| `project_opencode_setup.md` | Historique setup OpenCode; détails dans la doc locale. |
| `project_openrouter_work2.md` | Ancien retour Claude; état ensuite supersédé. |
| `project_post_update_checklist.md` | Checklist obligatoire après update et build. |
| `project_provider_migration_purge.md` | Purger la continuation du provider lors d'une bascule cassée. |
| `project_rtk_containers.md` | RTK retiré des containers. |
| `project_secrets_minimization.md` | Moindre exposition et audit de périmètre. |
| `project_supply_watch.md` | Veille unifiée, délai trois jours, aucune auto-installation. |
| `project_upstream_watch.md` | Veille upstream absorbée par supply-watch. |
| `project_v2_migration.md` | Migration v2 historique et points de rollback. |
| `project_vault_doctrine.md` | Doctrine Bitwarden + OneCLI/vault au spawn. |

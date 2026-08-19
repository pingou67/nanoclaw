---
name: Post-update checklist — local patches to verify after every /update-nanoclaw
description: All local modifications to verify and reapply after each upstream merge (post-v2 migration + Mattermost adapter cutover)
type: project
originSessionId: 7b0faab2-f973-4d6c-8c92-9292fadef9aa
---
## When to run

Les sections numérotées se passent après chaque `/update-nanoclaw` et **avant**
`systemctl --user restart nanoclaw`. Le **§−1 ci-dessous se lit AVANT de lancer
la mise à jour** — il n'a plus d'utilité une fois le merge fait.

If you ran `pnpm run build` and the build failed, this checklist tells you what to reapply.

---

## §−1. Avant de lancer la mise à jour — les cinq façons connues de se coûter cher

Ces règles ne viennent pas d'une théorie mais de dégâts constatés. Le skill
`/update-nanoclaw` d'upstream ignore tout de cet hôte : il ne dira rien de ce
qui suit.

### 1. Arrêter le service AVANT le merge

```bash
systemctl --user stop nanoclaw
# merge → pnpm install → build → tests → stamp
pnpm exec tsx scripts/upgrade-state.ts set "" update-nanoclaw
systemctl --user start nanoclaw
```

**Pourquoi.** Le merge fait bouger la version de `package.json` avant que le
marqueur d'upgrade soit posé. Le service, lui, continue de redémarrer : à chaque
tentative le tripwire refuse de démarrer (« install not on the sanctioned path »)
et le circuit breaker double son délai — 10 s, 30 s, 120 s, 300 s, **900 s**. Le
1er août 2026 ça a donné une douzaine de minutes d'indisponibilité pour rien, et
le délai en cours aurait tenu un quart d'heure de plus sans intervention.

Corollaire : ne pas « réparer » le tripwire en le contournant. Il fait
exactement son travail — c'est de le déclencher inutilement qu'il faut éviter.

### 2. `/usr/bin` en tête du PATH pour tout `install` / `rebuild`

```bash
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="/usr/bin:$PNPM_HOME:$PATH"    # node 20 = celui du service
```

**Pourquoi.** Le PATH interactif met souvent en avant le node 22 de pi-node.
`better-sqlite3` est natif : compilé sous 22 (`NODE_MODULE_VERSION 127`), il est
illisible par le node 20 du service (`115`), et l'hôte crash-loop. Vécu le
2026-08-01 : seize crashes d'affilée. Voir `CLAUDE.local.md`.

Ne pas remplacer le PATH complet non plus — `onecli` doit y rester,
sinon les commandes de cette checklist échouent avec un `command not found`
trompeur.

### 2 bis. Poser le marqueur d'upgrade APRÈS le dernier commit (2026-08-19)

Depuis la 2.2.0, `data/upgrade-state.json` n'enregistre plus seulement la
version : il enregistre le **commit et l'arbre**. Un marqueur posé avant un
commit supplémentaire (un bump de pin, un reformatage prettier) ne correspond
donc plus à l'arbre en place, le tripwire refuse le démarrage et le circuit
breaker repart à 10 s, 30 s, 120 s…

```bash
git commit …                       # TOUS les commits d'abord
git status --porcelain             # doit être vide
pnpm exec tsx scripts/upgrade-state.ts set "" update-nanoclaw
systemctl --user start nanoclaw
```

Symptôme si l'ordre est inversé : la suite E2E échoue au **setup** avec
« WS reported ready but mock has no client connected » — un message qui parle
du mock et jamais du marqueur.

### 3. Conserver la sortie de la suite E2E

```bash
python3 -u tests/integration/mattermost/run_suite.py 2>&1 | tee logs/e2e-run-$(date +%Y%m%d-%H%M).log
```

**Pourquoi.** `logs/e2e-last-run.json` n'est qu'un résumé chiffré : **l'identité
d'un scénario en échec ne vit que dans stdout**. Le 2026-08-01, un run est sorti
à 28/29 ; la sortie n'ayant pas été gardée, le scénario rouge est resté
inconnu et l'est encore. Un run vert ensuite ne prouve rien sur celui d'avant.

Lecture du résultat, sans ambiguïté : un skip est construit
`Result(..., True, skipped=True)`, donc **compté dans `passed`**. La suite est
verte si et seulement si `passed == total`. `29/29 (1 skipped)` est vert ;
`28/29 (1 skipped)` veut dire qu'un scénario a échoué.

### 4. Ne pas corriger un compteur sans avoir reproduit l'échec

C'est la faute la plus coûteuse parce qu'elle est invisible : le 2026-08-01, un
échec E2E réel a été « corrigé » en modifiant l'arithmétique du marqueur, qui
s'est mis à annoncer zéro échec — et `dashboard-health.ts` lit ce fichier, donc
la santé affichait vert sur une suite rouge.

La règle : **écrire le cas de test avant de toucher la ligne**. Trois lignes de
Python auraient montré que la formule était juste et que le rouge venait
d'ailleurs. Un chiffre qui surprend est une information, pas un bug à faire
taire.

### 5. Terminer le travail

- **Fichier skill-owned modifié** (`src/channels/mattermost.ts`,
  `tests/integration/mattermost/run_suite.py`, `src/providers/opencode.ts`…) →
  `pnpm exec tsx scripts/skills-sync.ts sync <skill>`, sinon `pnpm test` vire au
  rouge à la prochaine exécution.
- **Pousser les deux remotes** — `origin` ET `gitea`. Un seul des deux poussé
  laisse une divergence qu'on ne découvre qu'au merge suivant.
- **Arbre propre après le dernier commit** — le hook de commit lance
  `prettier --write` : s'il reformate un fichier déjà commité, la modification
  reste dehors. Un `git status --porcelain` vide est la seule preuve d'avoir fini.

---

## §0. Skills du fork — vérification automatique (2026-07-02)

Les modules mattermost/opencode/agy + vikunja sont
**skill-owned** (voir README.md, carte skills vs reliquat) — leurs sections
historiques ci-dessous (§3, §4, §5 pour Mattermost) sont couvertes
automatiquement :

```bash
pnpm exec tsx scripts/skills-sync.ts check   # payload en phase + reach-ins présents
pnpm test                                    # inclut scripts/skills-sync.test.ts (même check)
```

- Un `✗ [missing-line]` = l'update a écrasé une ligne barrel / une dep / un
  ARG Dockerfile → re-suivre le SKILL.md du skill concerné (étapes idempotentes).
- Un `✗ [branch-drift]` = l'update a modifié un fichier skill-owned (rebase
  d'un fix upstream ?) → arbitrer, puis `skills-sync sync <skill>`.
- Un skill **non installé** doit sortir `✓ … (non installé — installable)` —
  c'est la garantie « les skills marchent après chaque màj même non installés ».
- La suite E2E (§13) skippe d'elle-même les scénarios des skills absents.

---

## Quick health check (one-liner)

```bash
cd /home/pegon/nanoclaw && bash -c '
fail=0
grep -q "claudeCredentials" src/container-runner.ts && echo "✓ 1. OAuth patch OK" || { echo "✗ 1. OAuth patch MISSING (see §1)"; fail=1; }
# (2. groups/global — contrôle retiré le 2026-07-30, sans objet : voir §2)
[ -f src/channels/mattermost.ts ] && echo "✓ 3. MattermostAdapter present" || { echo "✗ 3. MattermostAdapter MISSING (see §3)"; fail=1; }
grep -q "import .\\./mattermost" src/channels/index.ts && echo "✓ 4. Mattermost imported in registry" || { echo "✗ 4. import missing (see §4)"; fail=1; }
grep -q "\"ws\":" package.json && echo "✓ 5. ws dependency present" || { echo "✗ 5. ws dependency missing (see §5)"; fail=1; }
which libreoffice >/dev/null 2>&1 && echo "✓ 5b. libreoffice installed" || { echo "✗ 5b. libreoffice missing — sudo apt install libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress"; fail=1; }
[ -f data/mattermost.json ] && echo "✓ 6. data/mattermost.json present" || { echo "✗ 6. data/mattermost.json missing (see §6) — gitignored, restore from backup"; fail=1; }
# Compte derive du disque, jamais code en dur : un seuil fige finit par crier
# au loup (7 etait faux, il y a 10 groupes). La consigne permanente sappelle
# CLAUDE.md sur claude et AGENTS.md sur codex : exiger la premiere partout
# faisait sortir 9/10 sur testor-codex, ne sur codex (voir §7). Pas
# dapostrophe ici : tout le bloc vit dans un bash -c "..." en quotes simples.
g=$(ls -d groups/mattermost_*/ 2>/dev/null | wc -l); n=0
for d in groups/mattermost_*/; do [ -f "$d/CLAUDE.md" ] || [ -f "$d/AGENTS.md" ] && n=$((n+1)); done
[ "$n" = "$g" ] && echo "✓ 7. consigne permanente présente dans les $g groupes mattermost_*" || { echo "✗ 7. seulement $n/$g avec CLAUDE.md ou AGENTS.md (voir §7)"; fail=1; }
[ -f src/secrets/vault.ts ] && grep -q "resolveVaultRefs" src/container-runner.ts && echo "✓ 8. résolution vault câblée au spawn" || { echo "✗ 8. patch coffre MANQUANT (voir §S)"; fail=1; }
grep -q "redactContainerConfig" src/dashboard-pusher.ts && echo "✓ 9. caviardage dashboard actif" || { echo "✗ 9. caviardage dashboard MANQUANT — secrets publiés sur 0.0.0.0 (voir §S)"; fail=1; }
[ "$fail" = "0" ] && echo "" && echo "ALL CHECKS PASS — safe to restart" || { echo ""; echo "Reapply missing patches before restart"; exit 1; }
'
```

---

## §M. Mounts — un `containerPath` absolu est refusé en silence (2026-08-01)

`validateMount` exige un `containerPath` **relatif** (il préfixe lui-même
`/workspace/extra/`). Un chemin absolu en base n'empêche pas le container de
démarrer : le mount est simplement écarté, avec un `WARN` noyé dans le journal.
Le groupe tourne alors sans son répertoire, et le symptôme remonte des semaines
plus tard sous la forme « l'agent ne trouve plus mes dépôts ». Vécu sur `coding`
(`/workspace/extra/dev` au lieu de `dev`), 130 rejets avant qu'on le voie.

```bash
# Doit valoir 0 — tout containerPath commençant par « / » sera rejeté au spawn
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT count(*) FROM container_configs, json_each(json(additional_mounts))
   WHERE json_extract(value, '\$.containerPath') LIKE '/%'"
```

Correction : réécrire la valeur en relatif, puis vérifier qu'aucun
`Additional mount REJECTED` ne suit le prochain spawn du groupe.

Même logique pour la clé `nonMainReadOnly` de
`~/.config/nanoclaw/mount-allowlist.json` : `setup/mounts.ts` l'écrit encore,
mais le validateur ne la connaît pas et proteste à **chaque** chargement de
l'allowlist. Son défaut côté setup vaut `true` — la retirer du fichier ne change
donc rien au comportement et rend le journal lisible. Un avertissement permanent
qu'on apprend à ignorer masque le suivant.

---

## §S. Secrets — coffre, périmètre, caviardage (2026-07-30)

Ces quatre contrôles ne demandent que quelques secondes et attrapent des
défaillances **silencieuses** : rien ne casse quand ils échouent, un secret est
simplement joignable par qui n'en a plus l'usage, ou un contrôle reste vert en
ayant cessé de vérifier quoi que ce soit.

```bash
cd /home/pegon/nanoclaw

# 1. Aucun secret en clair en base (doit valoir 0)
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT count(*) FROM container_configs WHERE mcp_servers LIKE '%sk-%' OR env LIKE '%sk-%'
                                             OR mcp_servers LIKE '%tk_%' OR env LIKE '%tk_%'"

# 2. Périmètre OneCLI == besoin réel (sort 1 si écart ; un agent auto-créé naît en mode `all`)
pnpm exec tsx scripts/check-secret-scope.ts

# 3. Coffre lisible et cibles d'injection prêtes
pnpm exec tsx scripts/sync-vault-to-onecli.ts --check

# 4. Rien de secret ne sort vers le dashboard (doit être vide)
TOKEN=$(curl -s http://127.0.0.1:3100/dashboard | grep -oP 'dashboard-token" content="\K[^"]+')
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/api/agent-groups \
  | grep -oE 'private_[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9]{20,}|tk_[A-Za-z0-9]{20,}'
```

Vérifier aussi que l'ordre de résolution des références de coffre a survécu au
merge — `pnpm test` couvre le cas, mais l'échec est sinon distant et trompeur
(« No credentials configured for opencode.ai ») :

```bash
pnpm exec vitest run src/secrets/ src/dashboard-redact.test.ts
```

**Écart connu et assumé au 2026-07-30** : le contrôle 2 sort en 1 à cause de
l'agent `default` de la passerelle, laissé en mode `all`. Nanoclaw ne l'utilise
jamais (`ensureAgent` crée toujours une identité par groupe), mais c'est
l'identité de repli d'OneCLI, hors périmètre nanoclaw — décision de Pegs, en
attente. **Un seul écart attendu : si le script en signale d'autres, ils sont
nouveaux.**

Si le paquet `@nanoco/nanoclaw-dashboard` a changé de version, re-porter le
patch pnpm (page Agents + actions) — voir `docs/local-patches/README.md`.

---

## §1. Claude Pro OAuth credential mount (`src/container-runner.ts`)

**Verify:** `grep -n "claudeCredentials" src/container-runner.ts` returns lines.

**If missing**, reapply in `buildContainerArgs()`. Find the line `args.push(imageTag);` and insert this block **immediately before** it:

```typescript
  // Mount Claude OAuth credentials (Pro/Max subscription) if present.
  // Allows the agent to authenticate using the host's subscription without
  // exposing tokens as environment variables.
  // When credentials.json is available, override OneCLI's placeholder API key
  // and proxy so the Claude SDK reads OAuth tokens directly from the file.
  const homeDir = process.env.HOME || `/home/${process.env.USER || 'node'}`;
  const claudeCredentials = path.join(homeDir, '.claude', '.credentials.json');
  if (fs.existsSync(claudeCredentials)) {
    args.push(...readonlyMountArgs(claudeCredentials, '/home/node/.claude/.credentials.json'));
    args.push('-e', 'ANTHROPIC_API_KEY=');
    args.push('-e', 'HTTPS_PROXY=');
    args.push('-e', 'HTTP_PROXY=');
  }

```

**Why:** NanoClaw uses a Claude Pro subscription via `~/.claude/.credentials.json`, not an API key. OneCLI's placeholder `ANTHROPIC_API_KEY` and HTTPS_PROXY would override the OAuth flow if not cleared. See `project_claude_pro_auth.md`.

---

## §2. ~~Preserve `groups/global/` on startup~~ — SANS OBJET depuis le 2026-07-30

**Ne rien reporter.** Vérifié ce jour : `migrateGroupsToClaudeLocal()` n'existe
plus nulle part dans `src/` (la fonction de migration v1→v2 a été retirée en
amont), `groups/global/` n'existe pas sur disque, et aucun code ne le supprime
— `group-folder.ts` se contente de réserver le nom. Le contrôle a donc été
retiré du one-liner : il aurait signalé « MISSING » indéfiniment pour un patch
qui n'a plus rien à protéger, et **un contrôle qui crie au loup apprend à
ignorer toute la checklist**.

Si un jour un mécanisme réintroduit la suppression de `groups/global/`, c'est
la note historique ci-dessous qui explique pourquoi le fork la préservait.

<details><summary>Note historique</summary>

**Verify (obsolète) :** `grep -q "Local patch: keep groups/global" src/claude-md-compose.ts && echo OK || echo MISSING`.

**If missing**, find the block in `migrateGroupsToClaudeLocal()` near the bottom:
```typescript
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }
```

Replace with:
```typescript
  // Local patch: keep groups/global/ — used by standalone mattermost-bot
  // (commentaire bloc explicatif sur le keep-groups/global)
  // v2-managed agents read the shared base from container/CLAUDE.md instead.
```

**Why:** v2 considers `groups/global/` obsolete and wipes it on every startup. Notre fork préserve ce dossier comme safety net pour des futurs agent groups qui voudraient leur propre mount partagé, et pour ne pas perdre silencieusement un `groups/global/CLAUDE.md` customisé entre deux restarts. See `project_v2_migration.md` §8.

</details>

---

## §3. MattermostAdapter v2 (`src/channels/mattermost.ts`)

**Verify:** `[ -f src/channels/mattermost.ts ] && wc -l src/channels/mattermost.ts`.

Should exist with ~430 lines. Won't appear in upstream (we created it). If accidentally deleted, restore from backup:
```bash
git checkout backup/pre-mattermost-v2-b2f9232-20260426-201218 -- src/channels/mattermost.ts
```

Or from disk snapshot:
```bash
cp ~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/src/channels/mattermost.ts src/channels/
```

If upstream eventually adds its own Mattermost adapter, **DO NOT auto-merge**. Compare implementations and merge by hand — our adapter has the cron import + thread root_id propagation + DM lazy registration features that are non-trivial.

**Typing indicator patch** : vérifier que `setTyping` utilise `api('POST', '/users/me/typing', ...)` et **non** un send WebSocket `user_typing`. Les bots Mattermost sont silencieusement filtrés pour les events WS typing — seule l'API REST fonctionne. Voir `docs/local-patches/MATTERMOST_TYPING_INDICATOR.md`.

See `project_mattermost_v2_adapter.md` for the full design.

---

## §4. Mattermost adapter side-effect import (`src/channels/index.ts`)

**Verify:** `grep -q "import './mattermost.js'" src/channels/index.ts`.

**If missing**, append after `import './cli.js';`:
```typescript
import './mattermost.js';
```

The file's `registerChannelAdapter('mattermost', ...)` runs at import-time. Without this line, the adapter never gets registered, no Mattermost monitoring happens.

---

## §5. `ws` + `@types/ws` dependencies (`package.json`)

**Verify:** `grep -q '"ws":' package.json && grep -q '"@types/ws":' package.json`.

**If missing**, reinstall:
```bash
export PNPM_HOME="$HOME/.local/share/pnpm" && export PATH="$PNPM_HOME:$PATH"
pnpm add ws @types/ws
```

**Why:** The MattermostAdapter uses `ws` for the WebSocket connection. Node 22 has no built-in WebSocket so this dep is required.

---

## §6. Mattermost runtime config (`data/mattermost.json`)

**Verify:** `[ -f data/mattermost.json ] && jq -r .url data/mattermost.json`.

This file is **gitignored** (data/ is excluded), so it survives merges but can be lost on disk wipes. If missing, restore from backup:
```bash
cp ~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/data/mattermost.json data/mattermost.json
chmod 600 data/mattermost.json
```

If no backup, recreate (full template in `project_mattermost_v2_adapter.md`):
```json
{
  "url": "https://mm.pegs.fr",
  "token": "<bot-token-from-mm-system-console>",
  "channels": [
    { "channel": "main",      "folder": "mattermost_main",      "requireMention": true  },
    { "channel": "work",      "folder": "mattermost_work",      "requireMention": false },
    { "channel": "mainframe", "folder": "mattermost_mainframe", "requireMention": false },
    { "channel": "adminsys",  "folder": "mattermost_adminsys",  "requireMention": false },
    { "channel": "famille",   "folder": "mattermost_famille",   "requireMention": true  },
    { "channel": "coding",    "folder": "mattermost_coding",    "requireMention": false },
    { "isDM": true,           "folder": "mattermost_dm",        "requireMention": false }
  ]
}
```

---

## §7. Consigne permanente par canal dans `groups/mattermost_*/`

**Verify:** chaque groupe porte `CLAUDE.md` **ou** `AGENTS.md`.

```bash
for d in groups/mattermost_*/; do
  [ -f "$d/CLAUDE.md" ] || [ -f "$d/AGENTS.md" ] || echo "SANS consigne : $d"
done
```

> **Le contrôle a été rendu aveugle au provider le 2026-08-13.** Il exigeait
> `CLAUDE.md` partout et sortait `9/10`. Ce n'était pas une perte de fichier :
> `testor-codex` est le seul groupe **né** sur codex, et codex lit `AGENTS.md`,
> pas `CLAUDE.md`. Les six groupes migrés le 12/08 ont gardé leur `CLAUDE.md`
> d'origine en plus de leur `AGENTS.md`, ce qui masquait l'angle mort : seul un
> groupe créé directement sur codex l'expose. Vérifié en base
> (`container_configs.provider`) avant de toucher au contrôle, conformément au
> §−1.4 — le compteur avait raison de surprendre, c'est sa règle qui était
> périmée.

These are gitignored in v2 (`groups/*` is excluded). If missing after a fresh checkout or accidental delete:
```bash
for g in mattermost_adminsys mattermost_coding mattermost_dm mattermost_famille mattermost_main mattermost_mainframe mattermost_work; do
  cp ~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/groups/$g/CLAUDE.md groups/$g/CLAUDE.md
done
```

**Why:** Per-group identity, behavior rules, channel-specific instructions. Without it, the agent has no idea who Claw is, where journals/todos live, etc.

**Side note:** v2 also creates `CLAUDE.local.md` files (one-time auto-rename on first startup). Both `CLAUDE.md` (read by container/agent CLAUDE Code) and `CLAUDE.local.md` (per-group memory) coexist. Don't delete one to "clean up".

---

## §8. v2 DB rows for Mattermost (auto-created — verify only)

The MattermostAdapter auto-creates 6 `messaging_groups`, 6 `agent_groups`, 6 wirings on every startup if missing. **No manual action needed.** Verify after restart:

```bash
node -e "
const Database = require('/home/pegon/nanoclaw/node_modules/better-sqlite3');
const db = new Database('data/v2.db', {readonly:true});
console.log('agents:', db.prepare(\"SELECT COUNT(*) c FROM agent_groups WHERE folder LIKE 'mattermost_%'\").get());
console.log('mgs:', db.prepare(\"SELECT COUNT(*) c FROM messaging_groups WHERE channel_type='mattermost'\").get());
console.log('wirings:', db.prepare(\"SELECT COUNT(*) c FROM messaging_group_agents WHERE id LIKE 'mga-mm-%'\").get());
"
```

Expected: 6/6/6 (DM is +1 each, lazily on first DM event).

If counts are wrong, the adapter's `ensureRegistration()` is broken — check `src/channels/mattermost.ts`.

---

## §9. Crons auto-import (no manual action — verify only)

`groups/mattermost_*/crons.json` files (legacy v1 format) are auto-imported as v2 task messages on every startup. Idempotent (deterministic task IDs `cron-mm-<folder>-<index>`). Verify with:

```bash
find data/v2-sessions -name 'inbound.db' | while read db; do
  echo "$db:"
  node -e "
const Database = require('/home/pegon/nanoclaw/node_modules/better-sqlite3');
const d = new Database('$db', {readonly:true});
const rows = d.prepare(\"SELECT id, recurrence FROM messages_in WHERE kind='task' AND id LIKE 'cron-mm-%'\").all();
rows.forEach(r => console.log('  ', r.id, '→', r.recurrence));
" 2>/dev/null
done
```

If counts mismatch the JSON files, restart the service — adapter re-runs `importCronsForFolder()` on every boot and inserts any missing task rows.

---

## §10. mattermost-bot legacy tree (NOT used at runtime — verify NOT running)

`container/mattermost-bot/` and the `nanoclaw-mattermost-bot:latest` Docker image are **legacy** since the v2 cutover. The 7 standalone containers should NOT be running:

```bash
docker ps --filter 'name=nanoclaw-mattermost' --format '{{.Names}}'
```

Expected: empty. If anything appears (someone restarted the legacy script), stop it:
```bash
docker ps --filter 'name=nanoclaw-mattermost' -q | xargs -r docker stop
docker ps -a --filter 'name=nanoclaw-mattermost' -q | xargs -r docker rm
```

The image and source code are kept for reference (test-tools mock-mm). To fully remove later: `docker rmi nanoclaw-mattermost-bot:latest && git rm -r container/mattermost-bot/` (preserve `container/mattermost-bot/test-tools/` if you want to keep the mock-mm scenario harness).

**Note:** The active runtime containers are now named `nanoclaw-v2-mattermost_<channel>-<timestamp>` (auto-spawned by the v2 host on demand). Those are normal — that's the v2 adapter doing its job.

---

## §11. Build + tests

After applying any patch:
```bash
export PNPM_HOME="$HOME/.local/share/pnpm" && export PATH="$PNPM_HOME:$PATH"
pnpm install --frozen-lockfile     # if pnpm-lock.yaml changed
pnpm run build                      # tsc must pass clean
pnpm test                           # all 197+ tests should pass
```

If TypeScript errors after upstream merge, resolve them — most often it's because v2 refactored a module's API and our local patch references the old name. Common cases:
- `from '../db/messaging-groups.js'` — verify path/exports still match
- `from '../session-manager.js'` — same
- `from '../modules/scheduling/db.js'` — same
- `insertTask(...)` signature — check `src/modules/scheduling/db.ts`

---

## §12. Restart + smoke test

```bash
systemctl --user restart nanoclaw
sleep 5
systemctl --user is-active nanoclaw                    # → active
tail -25 /home/pegon/nanoclaw/logs/nanoclaw.log        # → "Mattermost WS ready"
```

Then send a real message in any channel (e.g. `@claw test` in #main) and check the bot replies.

For a more exhaustive E2E re-validation: `container/mattermost-bot/test-tools/mock-mm.py` + the scenario scripts in the same dir. See `project_mattermost_v2_adapter.md` for how to temporarily swap config to point at the mock during tests.

---

## §13. Replay E2E integration suite (REQUIRED at end of every update)

After §11 (build) and §12 (restart + smoke send a real message), replay
the full mock-mm E2E suite to catch regressions in the Mattermost
adapter's contract (routing, threading, attachments, container reuse):

```bash
cd /home/pegon/nanoclaw
python3 tests/integration/mattermost/run_suite.py
```

The suite (~2-3 min) runs in this order:
1. Starts a local mock Mattermost server (`tests/integration/mattermost/mock_mm.py`)
2. **Stops the live nanoclaw service**
3. Backs up `data/mattermost.json` to `.bak`, swaps in a mock-pointing config
4. Restarts nanoclaw, waits for `Mattermost WS ready`
5. Runs 11 scenarios via `POST /__test/inject` and verifies replies
6. Stops nanoclaw, **restores the live config**, restarts the service
7. Stops the mock

**Production downtime ≈ 2-3 min**. Mattermost retains messages
indefinitely so anything sent during the suite is delivered when the
adapter reconnects to the real server.

**Expected output (all green):**
```
============================================================
RESULTS
============================================================
  ✓ scenario_main — replied with OK-MAIN
  ✓ scenario_work — replied with OK-WK
  ✓ scenario_mainframe — replied with OK-MF
  ✓ scenario_adminsys — replied with OK-AS
  ✓ scenario_coding — replied with OK-CD
  ✓ scenario_famille — replied with OK-FAM
  ✓ must_ignore — no reply (correct)
  ✓ thread_propagation — root_id propagated (test-thread-root)
  ✓ dm_lazy — replied with OK-DM
  ✓ image_attachment — identified red (Rouge)
  ✓ container_reuse — T1=7.5s T2=3.2s (ratio=0.43)

11/11 passed
```

**If the suite fails midway** and leaves the service in mock mode:
```bash
pkill -f mock_mm.py
mv data/mattermost.json.bak data/mattermost.json
systemctl --user restart nanoclaw
```

**To debug a single scenario**:
```bash
python3 tests/integration/mattermost/run_suite.py --scenario scenario_main --keep-mock
# inspect logs, then manually clean up as above
```

See `tests/integration/mattermost/README.md` for details on each scenario,
the mock API surface, and common failure modes.

---

## §14. Backup tags reference

Each major change leaves a recovery point:

| Tag | Date | What it precedes |
|-----|------|------------------|
| `pre-v2-63ea4d0-20260426-104215` | 2026-04-26 10:42 | The v2 core merge |
| `pre-mattermost-v2-b2f9232-20260426-201218` | 2026-04-26 20:12 | The Mattermost adapter cutover |

Disk snapshots:
- `~/nanoclaw-backups/v1.2.53-20260426-104215/` (98M, full pre-v2)
- `~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/` (15M, src + data + groups + mattermost-bot)

Rollback: `git reset --hard <tag> && systemctl --user restart nanoclaw`.

---

## §14. When something is fundamentally broken

If `/update-nanoclaw` produces a state where you can't get back to working:

1. `git reset --hard pre-mattermost-v2-b2f9232-20260426-201218`
2. Restore disk state from `~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/` (data, groups, src, mattermost-bot tree)
3. `pnpm install && pnpm run build`
4. `systemctl --user restart nanoclaw`

This puts you back to the post-Mattermost-v2-cutover state where everything was validated working (10/10 E2E scenarios passing).

---

## What's NO LONGER part of this checklist (post-v2 migration)

These were in the v1 version of this checklist but no longer apply:

- **Image vision skill** (`src/image.ts`, `src/channels/whatsapp.ts`) — file deleted in v2 cleanup. Image attachments now flow through v2's native `extractAttachmentFiles()` (host-side base64 → disk inbox/) + agent-runner formatter. WhatsApp channel itself moved to the `channels` branch (not in trunk).
- **Document blocks + multimodal combiné in agent-runner** — v2 agent-runner is a complete rewrite (Bun, providers abstraction, poll-loop). Old patches don't port. Multimodal handled differently (file path + Read tool).
- **Model switching via `model.txt`** — never reapplied in v2. If needed, would have to be redone against v2's container-runner.
- **mattermost-bot 7 standalone containers running** — replaced by the v2 adapter. They should NOT be running.
- **`./container/build.sh` rebuild after merges** — still applies if `container/agent-runner/` source changes. Check `git diff <prev-merge-base>..HEAD -- container/agent-runner/` after a merge to decide.

---
name: NanoClaw v2 — migration faite (2026-04-26), coexistence v1+v2
description: Migration v2 réalisée le 2026-04-26 ; v2 tourne dans le service nanoclaw, mattermost-bot continue d'utiliser l'image v1
type: project
originSessionId: 7b0faab2-f973-4d6c-8c92-9292fadef9aa
---
## Statut actuel (2026-04-26)

Core nanoclaw migré en v2.0.13. Service `nanoclaw.service` actif sur `dist/index.js` v2.

**Architecture coexistence :**
- **Service nanoclaw (v2)** : utilise l'image `nanoclaw-agent-v2-c761ecdc:latest` (auto-slug v2)
- **Mattermost-bot (v1, intact)** : utilise toujours `nanoclaw-agent:latest` (= ancien v1, digest 74a10bcfcf9f). Egalement disponible sous tag `nanoclaw-agent:v1`.

**Why:** v2 est une réécriture complète (Bun, OneCLI, two-DB session split, channels en branche séparée). Le mattermost-bot dépend du contrat stdin/stdout du v1 — incompatible avec le polling DB v2. Solution : laisser cohabiter les deux images Docker (les noms diffèrent naturellement grâce à l'install-slug v2).

**How to apply:** Si tu rebuilds une image, vérifie que le tag visé est bien `nanoclaw-agent-v2-*` pour v2 ou `nanoclaw-agent:latest` pour v1 (mattermost-bot).

---

## Backup et rollback

- **Tag git** : `pre-v2-63ea4d0-20260426-104215`
- **Branche git** : `backup/pre-v2-63ea4d0-20260426-104215`
- **Snapshot disque** : `~/nanoclaw-backups/v1.2.53-20260426-104215/` (98M : data, groups, store, container, src, package.json, service unit)

Rollback : `git reset --hard pre-v2-63ea4d0-20260426-104215 && systemctl --user restart nanoclaw`

---

## Ce qui change pour v2

1. **DB** : v2 crée `data/v2.db` (nouvelle DB centrale) à côté des anciennes `data/nanoclaw.db` et `data/messages.db` (qui restent intactes mais inutilisées par v2).

2. **Channels en trunk** : aucun. Discord/Slack/etc. sont dans la branche `channels`. À réinstaller via `/add-discord` etc. si besoin.

3. **Patch OAuth credentials** : réappliqué dans `src/container-runner.ts` (avant `args.push(imageTag)`). Vérifier après chaque update :
   ```bash
   grep -n "claudeCredentials\|credentials.json" src/container-runner.ts
   ```

4. **Stale v1 files supprimés** : `src/credential-proxy.ts`, `document.ts`, `image.ts`, `session-commands.ts`, `text-styles.ts`, `whatsapp-auth.ts`, `src/channels/{discord,whatsapp,emacs}.ts` (déplacés vers la branche `channels`).

5. **groups/ gitignored** : v2 n'attend plus `groups/*` dans git. Les CLAUDE.md des groupes restent sur disque mais ne sont plus versionnés.

6. **Build** : `pnpm install && pnpm run build` (était `npm`). Les hooks husky exigent pnpm dans le PATH.

7. **Piège CLAUDE.md → CLAUDE.local.md** : v2 (`src/claude-md-compose.ts:migrateGroupsToClaudeLocal`) renomme tous les `groups/*/CLAUDE.md` en `CLAUDE.local.md` au premier startup. **Mais l'agent v1 qu'utilise mattermost-bot lit `CLAUDE.md` directement** → le bot perd son identité, ne sait plus où sont les fichiers `journal_*.md`, `todo.md`, etc. **Fix** : restaurer `CLAUDE.md` depuis `~/nanoclaw-backups/v1.2.53-20260426-104215/groups/$g/CLAUDE.md` pour les 7 groupes mattermost_*. Le rename ne se reproduira pas (idempotent : skip si `CLAUDE.local.md` existe). **Why:** v2 architecture suppose que les containers v2 lisent un `CLAUDE.md` composé à chaque spawn (base + local), mais mattermost-bot ne passe pas par cette compose.

8. **Patch local `src/claude-md-compose.ts`** : la suppression `groups/global/` au startup (lignes ~174-178 du fichier upstream) est commentée — on garde le dossier comme safety net pour des futurs agent groups qui voudraient leur propre mount partagé, et pour ne pas perdre silencieusement un `groups/global/CLAUDE.md` customisé. **How to apply** : vérifier après chaque update que le `fs.rmSync(globalDir, ...)` est bien commenté/absent.

---

## Ce qui reste à faire / à valider

- **Discord** : adapter Discord stoppé au boot v2 (canal v1 retiré). Si on veut le réactiver, lancer `/add-discord`.
- **Mattermost** : ✅ FAIT le 2026-04-26 — adapter natif v2 (`src/channels/mattermost.ts`) remplace les 7 standalone bot containers. Container reuse natif, attachments multimodal, threads, DM, crons. Voir `project_mattermost_v2_adapter.md`.
- **mattermost-bot legacy tree** : `container/mattermost-bot/` reste pour la référence + test-tools. Les 7 containers `nanoclaw-mattermost-*` sont stoppés en permanence. Suppression complète à faire dans une session future une fois la stabilité v2 confirmée.

---

## Skills v2 disponibles

- `/migrate-nanoclaw` — extrait les customs d'un fork et les rejoue sur base propre (alternative au merge in-place qu'on a fait)
- `/add-<channel>` (discord, slack, telegram, whatsapp, etc.) — réinstalle un canal depuis la branche channels
- `/add-opencode`, `/add-codex`, `/add-ollama-provider` — providers alternatifs
- `/init-onecli` — init OneCLI Agent Vault si besoin de credentials API

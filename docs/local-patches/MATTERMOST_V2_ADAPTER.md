---
name: Mattermost adapter v2 — natif in-process (2026-04-26)
description: Mattermost intégré comme channel adapter v2 (src/channels/mattermost.ts). Container reuse natif. Remplace les 7 standalone bot containers.
type: project
originSessionId: 7b0faab2-f973-4d6c-8c92-9292fadef9aa
---
## Vue d'ensemble

Le bot Mattermost vit dans le **processus nanoclaw v2 principal**, comme un channel adapter classique (cli, discord, etc.). Architecture identique à celle de Discord/Slack/etc. — bénéficie automatiquement de:
- Container reuse via host-sweep heartbeat (cold ~7s, warm ~3s)
- Session DBs (inbound.db / outbound.db) par channel
- Delivery polls
- Scheduling natif v2
- 1 container par canal (`session_mode='shared'`)

**Fichier principal** : `src/channels/mattermost.ts` (~430 lignes)
**Config** : `data/mattermost.json` (chmod 600)
**Auto-import** : `src/channels/index.ts` ajoute `import './mattermost.js'` (side-effect register)

---

## Config `data/mattermost.json`

```json
{
  "url": "https://mm.pegs.fr",
  "token": "<bot token>",
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

Chaque entrée non-DM crée idempotemment au démarrage : `messaging_groups` (platform_id `mm:<folder>`) + `agent_groups` (folder=<folder>) + wiring (engage_mode `mention` ou `pattern '.'`). Les DMs sont créés à la volée au 1er event.

Pour ajouter un canal : éditer ce fichier + `systemctl --user restart nanoclaw`. Pour retirer un canal : retirer l'entry, restart. Les rows DB persistent (pas de cleanup auto pour éviter de casser des sessions actives) — supprimer manuellement dans `data/v2.db` si besoin.

---

## Crons

Deux mécanismes en parallèle, tous deux gérés par v2 host-sweep (`src/host-sweep.ts` MODULE-HOOK:scheduling-recurrence) :

### 1. Default weekly summary — appliqué à TOUS les channels

Au boot, l'adapter ajoute automatiquement un task récurrent par channel :
- **Schedule** : `0 18 * * 0` (chaque dimanche 18h, Europe/Paris)
- **TaskID** : `task-default-weekly-summary-<folder>` (déterministe, idempotent)
- **Prompt** : "Fais un résumé de la semaine écoulée sur ce canal. Consulte l'historique des conversations de la semaine et les fichiers du workspace. Mentionne les principaux sujets abordés, les actions/décisions prises, les points marquants et les éventuelles questions en attente. Sauvegarde le résumé dans `semaines/semaine_<YYYY-WNN>.md` (numéro de semaine ISO)."
- Code : `addDefaultWeeklySummary()` dans `src/channels/mattermost.ts`
- Couverture lazy DM : ajouté à la première inbound-event d'un nouveau DM (au moment de `ensureRegistration`)

**Pour personnaliser ou désactiver** : éditer la fonction dans le code, ou ajouter un cron contradictoire dans le crons.json du channel concerné (les deux cohabitent — le default n'est pas désactivable per-folder via config, c'est un choix volontaire).

### 2. Crons custom per-folder (`groups/<folder>/crons.json`)

Auto-importé au démarrage de l'adapter dans la session du folder, via `insertTask` (kind=task, recurrence=cron string).

**ID déterministe** `cron-mm-<folder>-<index>` → idempotent, pas de doublons sur restart.

Format supporté (legacy mattermost-bot v1) :
```json
[
  { "schedule": "0 7 * * *", "prompt": "..." },
  { "schedule": "0 9 * * *", "message": "..." }
]
```
`prompt` : agent traite le prompt et répond. `message` : agent reçoit instruction "poste exactement ce message" (pas de direct-post path en v2 — passe quand même par l'agent, simplement avec instruction stricte).

---

## Mounts custom

`groups/<folder>/container.json` (format v2 standard) → `additionalMounts`. Migré depuis l'ancien `mounts.json` v1 par script lors du cutover. Validation par `src/modules/mount-security/index.ts` (allowlist `~/.config/nanoclaw/mount-allowlist.json`).

---

## Keepalive — defense in depth (2 niveaux)

Deux couches complémentaires détectent les connexions cassées, chacune attrape un mode de panne différent :

| Niveau | Détecte | Worst-case latency | Code |
|---|---|---|---|
| **TCP SO_KEEPALIVE** (kernel) | rupture réseau (cable, peer crash, NAT evict) | ~10 min | `sock.on('upgrade', req => req.socket.setKeepAlive(true, 30_000))` |
| **WS ping/pong** (RFC 6455) | proxy applicatif silencieux qui drop sans FIN | ~90s | ping 30s + pong timeout 60s + `sock.terminate()` |

Sans TCP keepalive, le kernel met ~15 min avant de déclarer la connexion morte (retransmit timeout). Sans WS ping, le pseudo "zombie" (TCP vivant mais Mattermost qui ne pousse plus) n'est jamais détecté.

**Vérification en prod** : `ss -tonep | grep $(systemctl --user show nanoclaw -p MainPID --value)` doit montrer `timer:(keepalive,...)` sur la socket vers Mattermost.

**Reproduit le 2026-04-26** (qui a motivé les fixes) : Audrey poste "Hello" dans #famille à 20:59:01 → bot répond. Audrey reposte 3 min plus tard à 21:01:59 → aucune trace dans les logs nanoclaw, message jamais inséré dans inbound.db. WS toujours ESTAB selon `ss`. Restart du service a relancé un nouveau WS qui marche. Avec les deux keepalives en place, ça devrait s'auto-récupérer dans <90s.

**Test E2E** : `scenario_ws_keepalive` dans `tests/integration/mattermost/run_suite.py` simule le zombie (mock désactive le pong manuel via `/__test/silence_ws`), vérifie le reconnect en <120s.

---

## Threading

`supportsThreads: false` (Mattermost root_id est sub-thread d'un channel, pas une conversation primary). L'adapter stocke le `root_id` du dernier inbound dans `pendingRootIdByPlatform` (Map). Le `deliver()` lit + clear ce root_id pour poster la réponse dans le même thread.

**Limite connue** : si plusieurs messages arrivent en parallèle dans le même channel (différents threads), le 2e écrase le root_id du 1er. En pratique ça arrive rarement avec un usage solo.

---

## Attachments multimodal

v2 fait l'extraction base64 → fichier disque automatiquement via `writeSessionMessage / extractAttachmentFiles` (src/session-manager.ts). L'adapter passe `content.attachments[].data` (base64), v2 sauvegarde dans `inbox/<msg_id>/<filename>`, le formatter agent-runner émet `[image: foo.png — saved to /workspace/inbox/<msg_id>/foo.png]`. Claude utilise son outil Read pour lire les images.

**Validé E2E** : PNG rouge envoyé via mock → bot répond "Rouge".

### Office documents (docx, xlsx, pptx, odt, ods, odp, rtf)

Pas natifs côté Claude API. L'adapter (`src/channels/mattermost.ts:downloadFile`) détecte les extensions via `OFFICE_EXTS` regex et appelle `convertOfficeToPdf()` qui invoque `libreoffice --headless --convert-to pdf` sur le host avant de pousser le fichier dans `content.attachments`. Le `mimeType` est rewritten en `application/pdf` → traité comme document block natif.

**Dépendance host** : `libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress` doivent être installés sur la machine qui run le service nanoclaw. Si pas installé, fallback gracieux : log warn + passe le fichier raw (bot le voit comme document inutilisable mais ne crash pas).

**Validé E2E** : `scenario_office_attachment` génère un .docx minimal contenant un mot magique → conversion PDF → Claude lit → extrait le mot → bot répond. ✓ 1/1 passed.

---

## Backup pré-cutover

- Tag git : `pre-mattermost-v2-b2f9232-20260426-201218`
- Branche : `backup/pre-mattermost-v2-b2f9232-20260426-201218`
- Snapshot : `~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/` (data + groups + src + mattermost-bot tree)

Rollback : `git reset --hard pre-mattermost-v2-b2f9232-20260426-201218 && rm data/mattermost.json && systemctl --user restart nanoclaw && <restart 7 standalone bots>` (script de redémarrage standalone à recréer ou copier depuis backup).

---

## Tests E2E

`container/mattermost-bot/test-tools/mock-mm.py` simule l'API Mattermost (HTTP REST + WS sur :8888). Pour lancer la suite v2:

1. Stop nanoclaw, swap `data/mattermost.json.real` ↔ une version pointant vers `http://127.0.0.1:8888`
2. `python3 container/mattermost-bot/test-tools/mock-mm.py > /tmp/mock-mm.log 2>&1 &`
3. Restart nanoclaw
4. Inject events via `POST /__test/inject` (body: user_id, message, channel_id, channel_type, file_ids?, root_id?)
5. Read replies via `GET /__test/replies`
6. Restore real config + restart

**Scenarios validés (10/10)** : 6 channels (mention/pattern), DM lazy, must-ignore, thread root_id, image, container reuse (cold 7.5s vs warm 3.2s).

---

## Standalone bots (legacy)

Les 7 containers `nanoclaw-mattermost-*` (image `nanoclaw-mattermost-bot:latest`, code `container/mattermost-bot/`) sont **stoppés** après cutover. Le code reste pour l'instant (référence + scénarios de test mock-mm).

À supprimer une fois la stabilité v2 confirmée:
- `docker rm $(docker ps -a --filter 'name=nanoclaw-mattermost-' -q)` (déjà fait — orphan cleanup au boot s'en occupe aussi)
- `docker rmi nanoclaw-mattermost-bot:latest` 
- `git rm -r container/mattermost-bot/` (sauf test-tools si on veut les garder)

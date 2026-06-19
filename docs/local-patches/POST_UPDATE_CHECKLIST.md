---
name: Post-update checklist — local patches to verify after every /update-nanoclaw
description: All local modifications to verify and reapply after each upstream merge (post-v2 migration + Mattermost adapter cutover)
type: project
originSessionId: 7b0faab2-f973-4d6c-8c92-9292fadef9aa
---
## When to run

After every `/update-nanoclaw`, BEFORE `systemctl --user restart nanoclaw`.

If you ran `pnpm run build` and the build failed, this checklist tells you what to reapply.

---

## Quick health check (one-liner)

```bash
cd /home/pegon/nanoclaw && bash -c '
fail=0
grep -q "claudeCredentials" src/container-runner.ts && echo "✓ 1. OAuth patch OK" || { echo "✗ 1. OAuth patch MISSING (see §1)"; fail=1; }
grep -q "Local patch: keep groups/global" src/claude-md-compose.ts && echo "✓ 2. global-dir preservation OK" || { echo "✗ 2. global-dir preservation MISSING (see §2)"; fail=1; }
[ -f src/channels/mattermost.ts ] && echo "✓ 3. MattermostAdapter present" || { echo "✗ 3. MattermostAdapter MISSING (see §3)"; fail=1; }
grep -q "import .\\./mattermost" src/channels/index.ts && echo "✓ 4. Mattermost imported in registry" || { echo "✗ 4. import missing (see §4)"; fail=1; }
grep -q "\"ws\":" package.json && echo "✓ 5. ws dependency present" || { echo "✗ 5. ws dependency missing (see §5)"; fail=1; }
which libreoffice >/dev/null 2>&1 && echo "✓ 5b. libreoffice installed" || { echo "✗ 5b. libreoffice missing — sudo apt install libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress"; fail=1; }
[ -f data/mattermost.json ] && echo "✓ 6. data/mattermost.json present" || { echo "✗ 6. data/mattermost.json missing (see §6) — gitignored, restore from backup"; fail=1; }
n=$(ls groups/mattermost_*/CLAUDE.md 2>/dev/null | wc -l)
[ "$n" = "7" ] && echo "✓ 7. CLAUDE.md present in 7 mattermost_* groups" || { echo "✗ 7. only $n/7 CLAUDE.md present (see §7)"; fail=1; }
[ "$fail" = "0" ] && echo "" && echo "ALL CHECKS PASS — safe to restart" || { echo ""; echo "Reapply missing patches before restart"; exit 1; }
'
```

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

## §2. Preserve `groups/global/` on startup (`src/claude-md-compose.ts`)

**Verify:** `grep -q "Local patch: keep groups/global" src/claude-md-compose.ts && echo OK || echo MISSING`.

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

## §7. Per-channel `CLAUDE.md` in `groups/mattermost_*/`

**Verify:** `ls groups/mattermost_*/CLAUDE.md | wc -l` should return `7`.

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

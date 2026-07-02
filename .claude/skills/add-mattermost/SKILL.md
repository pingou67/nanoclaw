---
name: add-mattermost
description: Add Mattermost channel integration via a native in-process adapter (WebSocket + REST v4). No Chat SDK bridge. Multi-channel + DM, threads via root_id, attachments with Office→PDF conversion, message edit/delete (live-status support), WS keepalive + missed-post catch-up.
---

# Add Mattermost Channel

A native adapter that drives the Mattermost REST v4 API and WebSocket event stream directly from the NanoClaw host process — no Chat SDK bridge, no companion bot container. It supports several channels plus DMs on one bot account, propagates thread `root_id`s, converts Office attachments to PDF (libreoffice, inside the agent container), edits/deletes its own posts (required by the live-status feature), detects zombie WebSockets, and replays posts missed during a disconnection (`posts?since=`).

This module lives on the `channels` branch of **this fork's origin** (pingou67/nanoclaw), not upstream — upstream has no Mattermost channel. The fork keeps the installed copy canonical and mirrors it to the branch with `scripts/skills-sync.ts` (see Maintenance).

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/mattermost.ts` exists
- `src/channels/mattermost-registration.test.ts` exists
- `src/channels/index.ts` contains `import './mattermost.js';`
- `ws` is listed in `package.json` dependencies and `@types/ws` in devDependencies
- `tests/integration/mattermost/run_suite.py` exists (the E2E harness)

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter, its registration test, and the E2E harness

```bash
git show origin/channels:src/channels/mattermost.ts                   > src/channels/mattermost.ts
git show origin/channels:src/channels/mattermost-registration.test.ts > src/channels/mattermost-registration.test.ts
mkdir -p tests/integration/mattermost
for f in README.md mock_mm.py run_suite.py .gitignore; do
  git show "origin/channels:tests/integration/mattermost/$f" > "tests/integration/mattermost/$f"
done
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './mattermost.js';
```

### 4. Install the WebSocket dependency (pinned)

```bash
pnpm install ws@^8.20.0
pnpm install -D @types/ws@^8.18.1
```

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/mattermost-registration.test.ts
```

Both must be clean before proceeding. The registration test is the integration guard: it imports the real channel barrel and asserts the registry contains `mattermost`. It goes red if the `import './mattermost.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `ws` isn't installed (the adapter imports it at module load). Importing is safe: the adapter opens no socket at import — connection happens in `setup()`.

## Credentials

Create a bot account in Mattermost (System Console → Integrations → Bot Accounts), grab its token, then write `data/mattermost.json` (install-specific — never committed):

```json
{
  "url": "https://your-mattermost.example.com",
  "token": "<bot token>",
  "channels": [
    { "channel": "main", "folder": "mattermost_main", "requireMention": true  },
    { "channel": "work", "folder": "mattermost_work", "requireMention": false },
    { "isDM": true,      "folder": "mattermost_dm",   "requireMention": false }
  ]
}
```

- One entry per Mattermost channel the bot should listen to; `folder` names the `agent_groups` row the channel wires to (`platform_id` = `mm:<folder>`).
- `requireMention: true` — the bot only engages when `@<bot_username>` is mentioned.
- The `isDM` entry handles ALL direct messages; messaging groups are lazily auto-created per DM channel on first inbound.
- The bot must be a member of each listed channel (add it from the Mattermost UI).
- Protect the file: `chmod 600 data/mattermost.json`.

Restart the service; the log should show `Mattermost WS ready`.

## E2E suite

`tests/integration/mattermost/run_suite.py` is the full end-to-end harness: it swaps `data/mattermost.json` for a local mock server (`mock_mm.py`), restarts the service, and drives 20+ scenarios (routing, mentions, threads, DMs, attachments, container reuse, WS keepalive, provider matrix, runner commands, live-status), then restores the production config.

```bash
python3 tests/integration/mattermost/run_suite.py
```

⚠️ It **restarts the service and swaps the production config** — expect a few minutes of downtime, and always check the restore succeeded (`data/mattermost.json` back to the real token). Scenarios that exercise other skills (`/add-opencode` provider matrix legs, provider switch) are automatically SKIPPED when those skills are not installed — the suite stays green on any skill subset.

## Maintenance (fork model)

The installed tree copy is canonical. After editing any file this skill owns, mirror it back to the branch:

```bash
pnpm exec tsx scripts/skills-sync.ts sync add-mattermost
```

`pnpm test` includes `scripts/skills-sync.test.ts`, which fails if the tree and `origin/channels` drift apart, or if the barrel line / `ws` dep disappears (e.g. after an upstream update). `skill-sync.json` in this directory is the manifest that drives both.

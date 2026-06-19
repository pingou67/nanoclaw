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

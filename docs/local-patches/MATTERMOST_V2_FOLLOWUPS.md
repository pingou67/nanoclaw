---
name: Mattermost v2 adapter — known follow-ups
description: Known limitations / not-yet-fixed issues in the in-process Mattermost adapter, with rationale and proposed fixes
type: project
originSessionId: 7b0faab2-f973-4d6c-8c92-9292fadef9aa
---
## §-1 (lesson learned 2026-04-27) — Mattermost link convention: markdown links, not inline-code

**Context**: pendant la copie Discord→Mattermost (2026-04), la règle globale des liens était "URL en backticks (inline code) pour éviter les previews". Le but : éviter que Mattermost génère des cartes preview qui prennent toute la place.

**Problème**: une URL en inline code n'est **pas cliquable**. Les news 7h en pâtissaient — Phil devait copier-coller manuellement.

**Vérité Mattermost** (vérifiée 2026-04-27) : les previews ne sont déclenchés QUE pour les **URLs nues** dans le texte. Les **markdown links `[texte](url)`** sont cliquables ET ne génèrent pas de preview. Best of both worlds.

**Fix appliqué** (2026-04-27, sur disque, gitignored donc à restorer si dossier supprimé) :
- `groups/global/CLAUDE.md` ligne ~107 : règle réécrite — prefer `[texte](url)`, label court descriptif, bare URL réservé au cas où on veut explicitement un preview
- `groups/mattermost_main/crons.json` : prompts news + tech mis à jour
- Tasks DB pendantes (cron-mm-mattermost_main-{0,1} + leurs recurrences) ré-écrites in-place

**Backup** des fichiers groups : pas dans git (gitignored). À recopier depuis disk snapshot si besoin (`~/nanoclaw-backups/pre-mattermost-v2-20260426-201218/groups/`).

---

## §0 (lesson learned 2026-04-26) — never insert into messages_out without a matching `delivered` row

**What happened**: while migrating v1 `store/messages.db` (510 historical messages) into v2 per-session DBs, the script inserted historical bot replies into `messages_out`. The v2 delivery poll (`src/delivery.ts`) treats any `messages_out` row without a matching `delivered` row as undelivered → 130 historical "Hal: bonjour Phil voici les actus..." messages got re-posted to #famille on Mattermost as spam.

**Why**: there's no "imported" or "skip-deliver" flag on `messages_out`. The contract is implicit: a message is considered new (to deliver) iff no `delivered` row exists yet.

**How to apply if re-importing historical data**:
1. Either skip outbound entirely (the agent's prior replies are not load-bearing — they're context the agent doesn't need to re-emit)
2. Or, if outbound IS needed for archive, batch-insert matching `delivered` rows in the same transaction:
   ```js
   inDb.prepare(`INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
                 VALUES (?, ?, 'archived', ?)`).run(id, 'v1-archive-' + id, ts);
   ```
   Use a synthetic `platform_message_id` and a non-`'delivered'` status (`'archived'`) so it's clear in audits.

**Cleanup pattern when you screw it up**:
- Extract the `platformMsgId` from `nanoclaw.log` for each `Message delivered` line tagged `v1-out-*`
- `curl -X DELETE -H "Authorization: Bearer $TOKEN" $URL/api/v4/posts/$pid` per id (works fine, 200 OK each)
- Then `DELETE FROM messages_out WHERE id LIKE 'v1-out-%'` and `DELETE FROM delivered WHERE message_out_id LIKE 'v1-%'` in the relevant session DBs

---

## §1 (open) — `unknown_sender_policy: 'public'` is permissive by default

**Where**: `src/channels/mattermost.ts:ensureRegistration()` sets every auto-created `messaging_groups` row with:

```typescript
unknown_sender_policy: 'public' as const,
```

**What this means**: any unknown user (someone the bot has never seen before) can interrogate Claw on any wired channel without prior approval from the owner. v2's default for chat platforms is `'request_approval'`, which queues a DM to the owner asking "user X is asking on channel Y, allow?" before the agent ever sees the message.

**Why it's set this way today**: Phil's setup is solo + family — there's no real abuse vector, and `'request_approval'` would have generated approval pings for every new family member added to a channel (Audrey, Agathe, etc. on 2026-04-26), which would have been annoying to confirm one by one during onboarding.

**Why this is worth revisiting later**:
- If a Mattermost channel ever gets opened to outside contacts, anyone there can use Claw's compute (and any tool with side effects: Home Assistant, Vercel, etc.) without the owner approving them.
- The `'public'` policy short-circuits v2's pending-sender-approval flow entirely, which means we lose the audit trail of "who was let in when, by whom".

**Proposed fix when revisited**:
1. Add a per-channel override in `data/mattermost.json`:
   ```json
   { "channel": "main", ..., "unknownSenderPolicy": "request_approval" }
   ```
   Default to `'public'` for back-compat, but encourage `'request_approval'` for any non-private channel.
2. Or simpler: flip the global default to `'request_approval'` and add a `"trustAllSenders": true` per-channel escape hatch for the family channels where the friction is unwanted.
3. Surface incoming approval requests via Mattermost DM to the owner (currently they would queue silently in the v2 approvals flow).

**Effort**: ~1 hour code + a scenario in the E2E suite to verify approval gating fires for `request_approval` channels and queues correctly.

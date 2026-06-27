---
name: add-teams
description: Add Microsoft Teams channel integration via Chat SDK.
---

# Add Microsoft Teams Channel

Adds Microsoft Teams support via the Chat SDK bridge — interactive chat in team
channels, group chats, and direct messages. NanoClaw doesn't ship channels in
trunk — this skill copies the Teams adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

Teams is the most involved channel NanoClaw supports — there's no "paste a
token" shortcut. You'll walk through about seven Azure portal steps (app
registration, client secret, Azure Bot resource, messaging endpoint, Teams
channel, app package, sideload). Take them one at a time; the prompts below
collect each value as you produce it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Teams adapter and its registration test
into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/teams.ts
src/channels/teams-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './teams.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/teams@4.26.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/teams-registration.test.ts
```

`teams-registration.test.ts` imports the real channel barrel and asserts the
registry contains `teams`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/teams` isn't installed (the
import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real Teams workspace is verified manually once the service
runs.

## Credentials

The adapter is installed and registered, but it can't receive a message until a
bot exists in Azure, points at this machine, and is sideloaded into Teams. None
of those steps can be clicked through by a parser, so they're operator
instructions — relay each one, then collect the value it produces.

Before you start, tell the user:

```nc:operator
Confirm you have everything Teams setup needs:
1. A Microsoft 365 tenant where you can sideload custom apps — free personal Teams does NOT support this; you need a Microsoft 365 Business / EDU / developer tenant with Teams admin or developer rights.
2. A way to expose an HTTPS endpoint from this machine (ngrok, a Cloudflare Tunnel, or a reverse-proxied VPS). Azure Bot Service delivers activities to it.
```

### Public URL

Azure Bot Service delivers messages to an HTTPS endpoint you control; it has to
reach this machine's webhook server (port 3000) at `/api/webhooks/teams`. If you
don't have a tunnel running yet, start one in another terminal first — e.g.
`ngrok http 3000` gives you `https://abcd1234.ngrok.io`.

```nc:prompt public_url validate:^https:// normalize:rstrip-slash
Paste your public base URL (https://…, no trailing path) — e.g. https://abcd1234.ngrok.io.
```

### Register the Azure app

Tell the user:

```nc:operator
Create the Azure AD app registration:
1. In https://portal.azure.com, search "App registrations" → "New registration".
2. Name it (e.g. "NanoClaw").
3. Supported account types: Single tenant (your org only — most common for self-host) OR Multi tenant (any Microsoft 365 tenant can add the bot).
4. Click Register.
5. On the Overview page, copy the Application (client) ID and, for a single-tenant app, the Directory (tenant) ID.
```

```nc:prompt app_id validate:^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$
Paste the Application (client) ID — App registration Overview page.
```
```nc:prompt app_type validate:^(SingleTenant|MultiTenant)$
Enter the app type — `SingleTenant` or `MultiTenant` (must match the account type you picked).
```
```nc:prompt app_tenant_id when:app_type=SingleTenant validate:^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$
Paste the Directory (tenant) ID — App registration Overview page (Single Tenant only).
```

### Create a client secret

Tell the user:

```nc:operator
Create the client secret:
1. In your app registration, open "Certificates & secrets".
2. Click "New client secret" — Description "nanoclaw", Expires 180 days (recommended) or longer.
3. Click Add.
4. COPY THE VALUE NOW — Azure only shows it once (the Value column, not the Secret ID).
```

```nc:prompt app_password secret min:20
Paste the client secret Value — Certificates & secrets (shown only once).
```

### Store the credentials

The adapter reads these from `.env` (set-if-absent, so a value you've already
filled in is never overwritten) and syncs them to the container.
`TEAMS_APP_TENANT_ID` is written only for a Single Tenant app; Multi Tenant
doesn't need it.

```nc:env-set
TEAMS_APP_ID={{app_id}}
TEAMS_APP_PASSWORD={{app_password}}
TEAMS_APP_TYPE={{app_type}}
```
```nc:env-set when:app_type=SingleTenant
TEAMS_APP_TENANT_ID={{app_tenant_id}}
```
```nc:env-sync
```

### Create the Azure Bot resource

Tell the user:

```nc:operator
Create the Azure Bot resource and point it at this machine:
1. In https://portal.azure.com, search "Azure Bot" → Create.
2. Bot handle: a unique name, e.g. nanoclaw-bot.
3. Type of App: {{app_type}} — Creation type: Use existing app registration.
4. App ID: {{app_id}}.
5. After creating, open the bot → Configuration and set Messaging endpoint to {{public_url}}/api/webhooks/teams, then Apply.
```

### Enable the Teams channel

Tell the user:

```nc:operator
Enable the Microsoft Teams channel on the bot:
1. Open your Azure Bot resource → Channels.
2. Click Microsoft Teams → Accept terms → Apply.
```

### Build the Teams app package

The manifest bakes in the Application (client) ID, so the Azure app registration
above must be done first — building with a blank `app_id` produces a package that
no bot can claim. Confirm it's set before generating the zip:

```nc:run effect:check
[ -n "{{app_id}}" ]
```

Generate the zip you'll sideload into Teams (manifest + icons, written to
`data/teams/teams-app-package.zip`). Re-running regenerates a fresh zip, so this
is safe to repeat.

```nc:run effect:external
pnpm exec tsx setup/channels/teams-manifest-build.ts --app-id "{{app_id}}" --url "{{public_url}}"
```

### Sideload the app into Teams

Tell the user:

```nc:operator
Sideload the generated app package into Teams:
1. Open Microsoft Teams → Apps → Manage your apps → Upload an app.
2. Click "Upload a custom app" (or "Upload for me or my teams").
3. Select data/teams/teams-app-package.zip and click Add.
4. If "Upload a custom app" is missing, your tenant admin has disabled sideloading — enable it in Teams Admin Center → Teams apps → Setup policies → Global → Upload custom apps = On.
```

## Restart

Restart the service so it loads the Teams adapter and the credentials you just
stored:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Finish wiring

Unlike Discord or Slack, a Teams bot's platform ID isn't known until you DM the
bot for the first time — the adapter derives it from the inbound activity. So
this skill installs the adapter and stops here; you finish the wiring once the
bot has seen its first message. Tell the user:

```nc:operator
The Teams adapter is live and the service is running. One thing is left: your Teams bot's platform ID (which NanoClaw needs to wire it to an agent group) only becomes known after you DM the bot for the first time. To finish:
1. Find your bot in Teams (search by name, or via the app you just sideloaded) and send it a message ("hi" is fine).
2. Tail logs/nanoclaw.log for the inbound — the router auto-creates a row in messaging_groups in data/v2.db.
3. Run scripts/init-first-agent.ts with --channel teams, the discovered platform_id, and your AAD user id — OR run /manage-channels to wire it interactively.
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise,
once you've DM'd the bot, wire this channel with `/init-first-agent` (or
`/manage-channels`).

## Channel Info

- **type**: `teams`
- **terminology**: Teams has "teams" containing "channels." The bot can also receive DMs (personal scope) and group chat messages. Channels support threaded replies.
- **platform-id-format**: `teams:{base64url-conversation-id}:{base64url-service-url}` — auto-generated by the adapter from the first inbound activity, not human-readable. Use the auto-created messaging group for wiring.
- **how-to-find-id**: Send a message to the bot in the channel or a DM. NanoClaw auto-creates a messaging group and logs the platform ID. Use that messaging group for wiring.
- **supports-threads**: yes (channels only; DMs and group chats are flat)
- **typical-use**: Team collaboration with the bot in channels; personal assistant via DMs
- **default-isolation**: Separate agent group per team. DMs can share an agent group with your main channel for unified personal memory.

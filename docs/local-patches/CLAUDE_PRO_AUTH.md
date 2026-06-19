---
name: Claude Pro subscription auth in NanoClaw — post-update checklist
description: Local patch to apply after every /update-nanoclaw — mounts ~/.claude/.credentials.json into containers for Claude Pro OAuth auth
type: project
---

## What this is

NanoClaw is configured to use a Claude Pro subscription (not an API key). This requires a local patch to `src/container-runner.ts` that mounts `~/.claude/.credentials.json` read-only into the container.

OneCLI is still installed but has no Anthropic secret configured. The Claude Agent SDK reads the OAuth tokens directly from the mounted file.

## AUTOMATIC RULE: apply after every /update-nanoclaw

After every upstream merge, **before restarting the service**, verify the patch is present in `src/container-runner.ts`:

```bash
grep -n "claudeCredentials\|credentials.json" src/container-runner.ts
```

If the grep returns nothing (patch was overwritten by upstream), re-apply it manually.

## Exact patch to apply if missing

In `src/container-runner.ts`, find the `buildContainerArgs()` function. Locate the line `args.push(CONTAINER_IMAGE);` and insert the following block **immediately before** it:

```typescript
  // Mount Claude OAuth credentials (Pro/Max subscription) if present.
  // Allows the agent to authenticate using the host's subscription without
  // exposing tokens as environment variables.
  // When credentials.json is available, override OneCLI's placeholder API key
  // and proxy so the Claude SDK reads OAuth tokens directly from the file.
  const homeDir = process.env.HOME || `/home/${process.env.USER || 'node'}`;
  const claudeCredentials = path.join(homeDir, '.claude', '.credentials.json');
  if (fs.existsSync(claudeCredentials)) {
    args.push(
      '-v',
      `${claudeCredentials}:/home/node/.claude/.credentials.json`,
    );
    args.push('-e', 'ANTHROPIC_API_KEY=');
    args.push('-e', 'HTTPS_PROXY=');
    args.push('-e', 'HTTP_PROXY=');
  }
```

After adding the block, run `npm run build` to verify it compiles.

**Why:** `claude setup-token` produces a one-time token that cannot be injected as an HTTP Authorization header. The real OAuth access/refresh tokens live in `~/.claude/.credentials.json` under `claudeAiOauth.accessToken`. OneCLI's injected `ANTHROPIC_API_KEY` and proxy vars would override this, so they must be cleared.

**How to verify the token is still valid:** check that `~/.claude/.credentials.json` exists and `claudeAiOauth.expiresAt` is in the future. If expired, run `claude` interactively on the host to refresh.

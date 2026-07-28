# Remove the kimi provider

Reverses everything `SKILL.md` installed. Run from the project root.

## 0. Move any kimi group off the provider first

```bash
ncl groups list
ncl groups config update --id <agent-group-id> --provider claude   # or opencode
ncl groups restart --id <agent-group-id>
```

The kimi continuation lives in its own `continuation:kimi` slot, so switching
providers starts a fresh conversation and leaves the old one recoverable if you
switch back. Carry the group's memory over if needed — see `/migrate-memory`.

## 1. Undo the proxy reach-in

In `src/container-runner.ts`, delete both lines:

```typescript
import { proxyClearingArgs } from './providers/kimi.js';
```
```typescript
  args.push(...proxyClearingArgs(_provider));
```

Do this **before** step 3 — the import breaks the build once the file is gone.

## 2. Delete the barrel imports

Remove this line from BOTH `src/providers/index.ts` and
`container/agent-runner/src/providers/index.ts`:

```typescript
import './kimi.js';
```

## 3. Delete the copied files

```bash
rm -f src/providers/kimi.ts src/providers/kimi-registration.test.ts src/providers/kimi-proxy.test.ts
rm -f container/agent-runner/src/providers/kimi.ts
rm -f container/agent-runner/src/providers/kimi.test.ts
rm -f docs/kimi-provider.md
```

## 4. Per-session state (optional)

Each kimi session staged a `KIMI_CODE_HOME` under its session directory —
kimi's transcripts, logs and the generated `config.toml` / `mcp.json` /
`AGENTS.md`. Harmless to leave; to reclaim the space:

```bash
rm -rf data/v2-sessions/*/*/kimi-home
```

Nothing there is a credential — the OAuth file was a mount, not a copy.

## 5. Host artifacts (optional)

The CLI binary and the Moonshot OAuth login live on the host, outside the repo.
Remove them only if nothing else uses them:

```bash
rm -rf ~/.kimi-code
```

## 6. Rebuild and restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
# Linux: systemctl --user restart nanoclaw
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

No image rebuild: the skill made no Dockerfile change. `pnpm test` must be
green — `scripts/skills-sync.test.ts` reports the skill as "non installé
(installable)" once `src/providers/kimi.ts` is gone.

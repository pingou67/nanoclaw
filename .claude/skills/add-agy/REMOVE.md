# Remove the agy provider

Reverses everything `SKILL.md` installed. Run from the project root.

## 0. Move any agy group off the provider first

```bash
ncl groups list
ncl groups config update --id <agent-group-id> --provider claude   # or opencode
ncl groups restart --id <agent-group-id>
```

Then carry the group's memory over if needed — see `/migrate-memory`.

## 1. Delete the barrel imports

Remove this line from BOTH `src/providers/index.ts` and
`container/agent-runner/src/providers/index.ts`:

```typescript
import './agy.js';
```

## 2. Delete the copied files

```bash
rm -f src/providers/agy.ts src/providers/agy-registration.test.ts
rm -f container/agent-runner/src/providers/agy.ts
rm -f container/agent-runner/src/providers/agy-registration.test.ts
rm -f container/agent-runner/src/providers/agy.factory.test.ts
rm -f container/agent-runner/src/providers/agy.memory.test.ts
rm -f docs/agy-provider.md
```

## 3. Host artifacts (optional)

The CLI binary and the Google OAuth login live on the host, outside the
repo. Remove them only if nothing else uses them:

```bash
rm -f ~/.local/bin/agy
rm -rf ~/.gemini
```

## 4. Rebuild and restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
# Linux: systemctl --user restart nanoclaw
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

No image rebuild: the skill made no Dockerfile change. `pnpm test` must be
green — `scripts/skills-sync.test.ts` reports the skill as "non installé
(installable)" once `src/providers/agy.ts` is gone.

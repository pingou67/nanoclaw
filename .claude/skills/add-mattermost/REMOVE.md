# Remove Mattermost Channel

Reverses everything `SKILL.md` installed. Run from the project root.

## 1. Delete the barrel import

Remove this line from `src/channels/index.ts`:

```typescript
import './mattermost.js';
```

## 2. Delete the copied files

```bash
rm -f src/channels/mattermost.ts
rm -f src/channels/mattermost-registration.test.ts
rm -rf tests/integration/mattermost
```

## 3. Uninstall the dependency

```bash
pnpm remove ws @types/ws
```

## 4. Remove the config and wiring

```bash
rm -f data/mattermost.json data/mattermost.json.bak
```

Then delete the Mattermost messaging groups and their wirings (`ncl messaging-groups list` → look for `platform_id` starting with `mm:` → `ncl wirings delete …` / `ncl messaging-groups delete …`). Agent groups (`ncl groups …`) are yours to keep or delete — they are not Mattermost-specific.

## 5. Rebuild and restart

```bash
pnpm run build
pnpm test
# Linux: systemctl --user restart nanoclaw
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

`pnpm test` must be green: `scripts/skills-sync.test.ts` reports the skill as "non installé (installable)" once the marker file is gone.

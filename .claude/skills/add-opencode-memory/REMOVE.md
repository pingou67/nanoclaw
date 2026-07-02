# Remove opencode-claude-memory

Reverses everything `SKILL.md` installed. Run from the project root.

## 1. Disable in every opted-in group

```bash
ncl groups list
ncl groups config env-unset --id <agent-group-id> --key NANOCLAW_OPENCODE_PLUGINS
```

## 2. Delete the shim

```bash
rm -f container/opencode-plugins/opencode-claude-memory.js
```

## 3. Remove the image package

Delete the `{ "name": "opencode-claude-memory", … }` entry from `container/cli-tools.json`, then:

```bash
./container/build.sh
ncl groups restart --id <agent-group-id> --rebuild   # each formerly opted-in group
```

## 4. Validate

```bash
pnpm test
```

`scripts/skills-sync.test.ts` reports the skill as "non installé (installable)" once the shim is gone. Saved memories under `data/v2-sessions/<gid>/.claude-shared/projects/*/memory/` are NOT deleted — remove them by hand if wanted.

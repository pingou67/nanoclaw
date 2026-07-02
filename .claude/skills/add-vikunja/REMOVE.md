# Remove the Vikunja MCP server

Reverses everything `SKILL.md` installed. Run from the project root.

## 1. Unwire every group

```bash
ncl groups list
ncl groups config remove-mcp-server --id <agent-group-id> --name vikunja
ncl groups restart --id <agent-group-id>
```

## 2. Delete the copied files

```bash
rm -rf container/agent-runner/src/mcp-servers/vikunja
```

Delete `container/agent-runner/src/mcp-servers/README.md` too if no other in-repo MCP server remains (the directory then disappears entirely).

## 3. Credentials

Remove the Vikunja secret from OneCLI if nothing else uses it (`onecli secrets list` → delete via the web UI at http://127.0.0.1:10254), or `ncl groups config env-unset` the per-group token if it was passed via env.

## 4. Validate

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
```

`scripts/skills-sync.test.ts` reports the skill as "non installé (installable)" once the server file is gone.

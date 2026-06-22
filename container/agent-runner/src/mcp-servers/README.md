# Serveurs MCP maison

Serveurs [MCP](https://modelcontextprotocol.io) écrits sur mesure pour NanoClaw,
versionnés dans le dépôt. Un sous-dossier par serveur.

| Serveur | Rôle |
|---------|------|
| [`vikunja/`](vikunja/) | API du gestionnaire de tâches Vikunja (tâches, projets, labels, commentaires, relations, assignees, filtres, notifications). |

## Pourquoi maison plutôt qu'un paquet npm

Un MCP tiers tournerait dans le container **avec les secrets du groupe** (token
d'API) — c'est précisément le risque que la politique supply-chain du dépôt évite
(`pnpm-workspace.yaml` : `minimumReleaseAge`, `onlyBuiltDependencies`). Un serveur
maison, sans dépendance tierce hors SDK MCP officiel (déjà dans l'image), reste
auditable et sous notre contrôle.

## Portabilité — claude / opencode / agy

Ces serveurs parlent le **transport MCP stdio standard**, donc n'importe quel
client MCP les pilote à l'identique :

- **Claude Code** : le SDK Agent lance l'entrée `mcpServers`.
- **OpenCode** : lance la même entrée `mcpServers`.
- **agy (Antigravity)** : le provider matérialise l'entrée en extension Gemini-CLI
  puis `agy plugin import` (voir `docs/agy-provider.md`).

L'arbre `agent-runner/src` est **bind-monté en lecture seule à `/app/src`** dans
tous les containers (même image, tous providers), et le SDK MCP est résolu depuis
`/app/node_modules` relativement au fichier — aucune dépendance au cwd ni au
provider.

## Câbler un serveur à un groupe

Le serveur est lancé par une entrée de `container_configs.mcp_servers` du groupe :

```jsonc
{
  "vikunja": {
    "command": "bun",
    "args": ["run", "/app/src/mcp-servers/vikunja/server.ts"],
    "env": { "VIKUNJA_URL": "https://…", "VIKUNJA_TOKEN": "…" }  // secrets ICI, pas dans le code
  }
}
```

via `ncl groups config add-mcp-server` ou un `UPDATE` SQL. Les secrets vivent dans
le champ `env` de l'entrée (DB centrale, hors git), **scopés au serveur** — ils ne
sont pas exposés comme variables d'env globales du container. Les changements
prennent effet au prochain `ncl groups restart`.

## Écrire un nouveau serveur

1. `mcp-servers/<nom>/server.ts` : `McpServer` + `StdioServerTransport` du SDK,
   `import` du SDK et de `zod` (présents dans `/app/node_modules`). Lis les
   secrets depuis `process.env`. N'écris **jamais** sur stdout (réservé au
   protocole) — diagnostics sur stderr.
2. `mcp-servers/<nom>/test-live.ts` : harnais d'intégration qui spawn le serveur
   via le **client MCP** du SDK et exerce chaque tool contre un vrai backend, avec
   nettoyage. Gardé par les variables d'env (sort proprement si absentes) — donc
   jamais joué en CI. Lancer :

   ```bash
   docker run --rm -e <SECRETS> -v "$PWD/container/agent-runner/src:/app/src:ro" \
     -w / --entrypoint bun <agent-image> run /app/src/mcp-servers/<nom>/test-live.ts
   ```
3. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` doit passer.

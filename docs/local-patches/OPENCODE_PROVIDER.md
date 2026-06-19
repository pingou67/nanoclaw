# OpenCode provider — DeepSeek/Gemma via OpenRouter (testor channel)

Setup permettant de faire tourner un agent nanoclaw avec un modèle non-Anthropic
(DeepSeek V3.2, Gemma 4 26B A4B…) via OpenCode + OpenRouter, avec :
- thinking mode (reasoning_effort)
- prompt caching (>90% hit ratio en pratique)
- recherche web (DuckDuckGo MCP officiel)
- support natif images (vision multimodale)
- support PDF via rasterisation page-par-page (pour modèles vision-only)

Ce document recense **tout ce qu'il faut hors trunk nanoclaw** pour que ce flow
marche bout-en-bout. Trunk fournit l'abstraction provider et la skill
`/add-opencode` qui copie les fichiers depuis la branche `providers/`. Tout le
reste ci-dessous est patch local nécessaire au runtime DeepSeek/Gemma.

## Vue d'ensemble

```
Mattermost  ─┐
             │
   #testor   │   ┌──────────────┐  HTTP    ┌───────────────────┐  HTTPS  ┌────────────┐
  ─────────  ├─→ │  nanoclaw    │ ──────→  │ injector-proxy    │ ──────→ │ OpenRouter │
             │   │  (host)      │  :4002   │ (systemd unit)    │         │  /api/v1   │
             │   └──────┬───────┘          │ - inject reasoning│         └─────┬──────┘
             │          │                  │ - pin providers   │               │
             │          │ spawn            │ - Bearer auth     │               │
             │          ▼                  └───────────────────┘               │
             │   ┌──────────────┐                                              │
             │   │ container    │ ─── stdio ──→ duckduckgo-mcp-server          │
             │   │ (opencode    │                                              │
             │   │  CLI 1.4.17) │                                              ▼
             │   └──────────────┘                                       ┌────────────┐
             │                                                          │  NextBit   │
             │                                                          │  / Io Net  │
             │                                                          │ / Ionstream│
             │                                                          └────────────┘
```

## 1. Image container (`container/Dockerfile`)

Ajouts au-dessus de la base trunk :

```dockerfile
ARG OPENCODE_VERSION=1.4.17
…
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "opencode-ai@${OPENCODE_VERSION}"

# Python + uv (DDG MCP server stdio)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv ca-certificates curl \
        poppler-utils \                       # <-- pour pdftoppm (PDF→PNG)
    && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV UV_TOOL_DIR=/opt/uv-tools
ENV UV_TOOL_BIN_DIR=/usr/local/bin
RUN /usr/local/bin/uv tool install duckduckgo-mcp-server \
    && chmod -R a+rX /opt/uv-tools \
    && [ -d /opt/uv-python ] && chmod -R a+rX /opt/uv-python || true
```

**Pourquoi**
- `opencode-ai@1.4.17` — runtime CLI ; doit matcher `@opencode-ai/sdk` dans
  `container/agent-runner/package.json` (1.14.x = breaking, ne pas bumper aveuglément).
- `python3 + uv + duckduckgo-mcp-server` — MCP server officiel `nickclyde/duckduckgo-mcp-server`,
  bien maintenu, exécuté via `uvx`. Pré-cached à build time pour éviter le délai 1ère spawn.
- `poppler-utils` — fournit `pdftoppm` pour la rasterisation PDF (cf. patch §3).

## 2. Patches code

### 2.1 `src/container-runner.ts` — provider gating

L'OAuth-credentials block (mount `~/.claude/.credentials.json` + clear `HTTPS_PROXY`)
ne doit s'appliquer qu'aux groupes en `provider=claude`. Sinon en mode opencode
le clear de proxy empêche OneCLI d'injecter la clé OpenRouter et l'agent reçoit
401 *"Missing Authentication header"*.

```typescript
if (fs.existsSync(claudeCredentials) && provider === 'claude') {
  args.push(...readonlyMountArgs(claudeCredentials, '/home/node/.claude/.credentials.json'));
  args.push('-e', 'ANTHROPIC_API_KEY=');
  args.push('-e', 'HTTPS_PROXY=');
  args.push('-e', 'HTTP_PROXY=');
}
```

### 2.2 `src/providers/opencode.ts` — env passthrough étendu

Le provider host-side doit forwarder `ANTHROPIC_BASE_URL` (lu par opencode dans
le container pour configurer baseURL upstream) + `OPENCODE_REASONING_EFFORT`
(notre custom env pour le thinking) + `host.docker.internal` dans NO_PROXY pour
que les calls vers le proxy local (port 4002) bypassent OneCLI.

```typescript
const env: Record<string, string> = {
  XDG_DATA_HOME: '/opencode-xdg',
  NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost,host.docker.internal'),
  no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost,host.docker.internal'),
};
for (const key of [
  'OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL',
  'OPENCODE_REASONING_EFFORT', 'ANTHROPIC_BASE_URL',
] as const) {
  const value = ctx.hostEnv[key];
  if (value) env[key] = value;
}
```

### 2.3 `container/agent-runner/src/providers/opencode.ts` — attachments multimodaux

Le formatter écrit les attachments comme markers texte
`[image: foo.png — saved to /workspace/inbox/<msgId>/foo.png]`.
Sans patch, ces markers arrivent comme du texte brut au modèle qui ne peut pas
les décoder. Patch : avant chaque `session.promptAsync`, scanner les markers,
lire les fichiers, et les ajouter en `FilePartInput` à côté du `TextPartInput`.

Pour les PDF (et tous les Office docs déjà convertis en PDF par l'adapter
Mattermost), rasterizer chaque page en PNG via `pdftoppm -png -r 150` puis
émettre une `FilePart` image par page.

```typescript
const ATTACH_RE = /\[(image|document|file|attachment):\s*([^—\]]+?)\s+—\s+saved to\s+([^\]]+)\]/gi;
const fileParts: Array<{ type: 'file'; mime: string; filename?: string; url: string }> = [];

for (const m of text.matchAll(ATTACH_RE)) {
  const filename = m[2].trim();
  const containerPath = m[3].trim();
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';

  if (mime === 'application/pdf') {
    // Rasterize each page → PNG → one FilePart per page
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfimg-'));
    const r = spawnSync('pdftoppm', ['-png', '-r', '150', containerPath, path.join(tmpDir, 'page')]);
    for (const page of fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort()) {
      const data = fs.readFileSync(path.join(tmpDir, page));
      fileParts.push({ type: 'file', mime: 'image/png', filename: `${filename}#${page}`, url: `data:image/png;base64,${data.toString('base64')}` });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    continue;
  }
  fileParts.push({
    type: 'file', mime, filename,
    url: `data:${mime};base64,${fs.readFileSync(containerPath).toString('base64')}`,
  });
}
const promptRes = await client.session.promptAsync({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text }, ...fileParts] },
});
```

> **Trade-off PDF→images** : chaque page = ~1500-2000 tokens d'input ;
> coûteux pour gros PDF mais nécessaire pour modèles vision-only. Pour des
> modèles avec PDF natif (`google/gemini-2.5-flash`, `anthropic/claude-*`) on
> pourrait court-circuiter — laissé tel quel par simplicité.

### 2.4 `container/agent-runner/src/providers/mcp-to-opencode.ts` — env optionnels

Bug upstream : `cfg.env` et `cfg.args` étaient déréférencés sans null-check
alors que les deux sont optionnels dans `McpServerConfig`. Crashait sur
`Object.keys(cfg.env)` si le container.json n'avait pas de `env`.

```typescript
out[name] = {
  type: 'local',
  command: [cfg.command, ...(cfg.args ?? [])],
  ...(cfg.env && Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
  enabled: true,
};
```

## 3. Injector proxy (`scripts/opencode-injector-proxy.mjs`)

OpenCode 1.4.x n'a pas d'API publique pour `reasoning_effort` (le champ
`model.options` n'est pas propagé au plugin upstream Vercel AI SDK). Le proxy
intercepte chaque request body avant forward et y injecte :

- `reasoning: { effort: <medium> }` (active le thinking)
- `provider: { order: [NextBit, "Io Net", Ionstream], allow_fallbacks: false }`
  (épingle les seuls providers OpenRouter qui supportent **tools + caching**
  pour le modèle visé, en mode strict — sans fallback les providers tiers
  cassés ne sont jamais sélectionnés)

Bonus : log structuré par requête : `prov=NextBit 2738ms (32tps) in=17971
(cached 17536/98%) out=88 reasoning=62`.

Bypasse OneCLI gateway (auth Bearer ajoutée par le proxy en dur depuis env
`OPENROUTER_API_KEY`). Listening sur HTTP plain port 4002, le container
accède via `http://host.docker.internal:4002/api/v1`.

### Unit systemd

`~/.config/systemd/user/openrouter-proxy-host.service` :

```ini
[Unit]
Description=OpenCode → OpenRouter injection proxy (reasoning_effort)
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pegon/nanoclaw/scripts/opencode-injector-proxy.mjs
Environment=PORT=4002
Environment=OPENROUTER_API_KEY=sk-or-v1-...
Environment=OPENROUTER_REASONING_EFFORT=medium
Environment="OPENROUTER_PROVIDERS=NextBit,Io Net,Ionstream"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

> **Piège systemd** : les valeurs avec espace doivent être quoted (`"Io Net"`)
> sinon systemd split sur l'espace et drop le reste — il n'y a pas d'erreur,
> juste un log « Invalid environment assignment ».

## 4. Configuration host

### `.env`

```env
# OpenCode provider — pour groupes avec provider=opencode dans container.json
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/google/gemma-4-26b-a4b-it
OPENCODE_SMALL_MODEL=openrouter/google/gemma-4-26b-a4b-it
OPENCODE_REASONING_EFFORT=medium
ANTHROPIC_BASE_URL=http://host.docker.internal:4002/api/v1
```

> Le `ANTHROPIC_BASE_URL` pointe vers **notre** proxy local, pas openrouter
> direct. Le proxy fait l'auth + l'injection puis forward vers OpenRouter.

### Service unit `nanoclaw.service`

Doit charger `.env` :

```ini
EnvironmentFile=-/home/pegon/nanoclaw/.env
```

(Le `-` rend le fichier optionnel — pas de fail si absent.)

## 5. Configuration per-group (testor)

`groups/mattermost_testor/container.json` :

```json
{
  "provider": "opencode",
  "mcpServers": {
    "duckduckgo": {
      "command": "duckduckgo-mcp-server",
      "args": [],
      "instructions": "Pour toute requête nécessitant une recherche web…"
    }
  },
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": "all",
  "groupName": "Claw (testor)",
  "assistantName": "Claw (testor)",
  "agentGroupId": "ag-mattermost_testor"
}
```

`groups/mattermost_testor/CLAUDE.local.md` : identité agent, style, etc.

`data/mattermost.json` : entry du channel
```json
{ "channel": "testor", "folder": "mattermost_testor", "requireMention": false }
```

## 6. OneCLI vault

Secret OpenRouter assigné à l'agent `Claw (testor)` :

```bash
# Secret (host-pattern openrouter.ai, header Authorization Bearer)
onecli secrets create --name "OpenRouter" --type generic \
  --value sk-or-v1-... --host-pattern openrouter.ai \
  --header-name "Authorization" --value-format "Bearer {value}"

# Assignation à l'agent (selective mode)
onecli agents set-secrets --id <agent-uuid> --secret-ids <secret-uuid>
```

> Note : avec notre injector-proxy en local + bypass `NO_PROXY=host.docker.internal`,
> OneCLI gateway n'intercepte pas les calls vers le proxy. La clé est en clair
> dans le service unit du proxy. Le secret OneCLI est conservé pour les futurs
> appels que l'agent ferait directement à `openrouter.ai` hors proxy.

## 7. Validations

### Lancement
```bash
sudo systemctl --user daemon-reload
sudo systemctl --user enable --now openrouter-proxy-host
sudo systemctl --user restart nanoclaw
docker rm -f $(docker ps -a --filter 'name=mattermost_testor' -q)   # reap stale
```

### Smoke
- Pose un message dans `#testor` → réponse arrive
- `journalctl --user -u openrouter-proxy-host -f` montre :
  ```
  req1 200 /api/v1/chat/completions prov=NextBit 1567ms (42tps) in=18193 (cached 17968/99%) out=66 reasoning=38 (effort=medium)
  ```
- `cached >0` au 2ème message confirme le caching
- `reasoning >0` confirme thinking actif (note : Gemma peut choisir de ne
  pas raisonner pour des questions triviales — `reasoning=0` n'est pas une
  panne du système, juste un choix du modèle)

### Test image
- Drag & drop d'un PNG/JPG dans #testor → Gemma le décrit (vision native)

### Test PDF
- Drag & drop d'un PDF → chaque page rasterisée en PNG 150 DPI → Gemma
  lit comme une suite d'images. Vérifier `journalctl …openrouter-proxy-host`,
  l'`in=N` doit augmenter de ~1500-2000 par page

## 8. Troubleshooting

| Symptôme | Cause probable | Fix |
|---|---|---|
| `req X 401 Missing Authentication header` | OAuth credentials block clear le HTTPS_PROXY pour le mauvais provider | Vérifier `provider === 'claude'` dans container-runner.ts |
| `Bad Request` sur la 1ère requête | OneCLI proxy intercepte les calls vers le local proxy | Vérifier `NO_PROXY=…,host.docker.internal` dans env container |
| Pas de réponse, container `Created` jamais `Up` | Stale `processing_ack` claim de >2h sur message_in | `DELETE FROM processing_ack WHERE status='processing'` dans outbound.db + reset `messages_in.status='pending'` |
| Container démarre mais réponse "I can't read PDFs" | Patch attachment opencode.ts manquant | Rebuild container, vérifier que `[image: …]` regex matche les markers du formatter |
| Modèle figé sur ancienne version (ex. v3.1 alors que .env dit v3.2) | Session OpenCode persistée dans XDG state | Wipe `data/v2-sessions/<group>/<sess>/opencode-xdg/*` + `DELETE FROM session_state` dans outbound.db |
| Proxy log montre `prov=Ionstream` lent (1tps) | Provider instable sélectionné en premier | Réordonner `OPENROUTER_PROVIDERS` (mettre les providers fiables en premier ; Ionstream uptime 48% en avril 2026) |
| `Invalid environment assignment, ignoring: Net,NextBit` dans systemd | Valeur Environment= avec espace non-quotée | Wrap dans guillemets : `Environment="OPENROUTER_PROVIDERS=NextBit,Io Net,Ionstream"` |

## 9. Ajouter un autre channel sur le même setup OpenCode

1. Créer `groups/mattermost_<nom>/container.json` avec `provider: "opencode"` et MCP DDG (copier celui de testor)
2. Ajouter entry dans `data/mattermost.json`
3. Restart nanoclaw
4. Le default weekly summary task est inséré auto, agent_group créé via `mattermost.json`
5. Assigner le secret OneCLI au nouvel agent (via `onecli agents secrets`) si besoin de creds direct

Pour un modèle différent par channel : il faudrait étendre le proxy pour
honorer un header `X-Or-Model` injecté par container, plus le passthrough
côté host. Pas implémenté — actuellement un seul modèle par instance proxy.

## 10. Liste exhaustive des fichiers touchés

| Fichier | Type de modif |
|---|---|
| `container/Dockerfile` | + `poppler-utils`, + opencode + uv + ddg pre-cache |
| `src/container-runner.ts` | OAuth gate `provider === 'claude'` |
| `src/providers/opencode.ts` | env passthrough étendu (BASE_URL, REASONING_EFFORT, host.docker.internal in NO_PROXY) |
| `container/agent-runner/src/providers/opencode.ts` | attachments → FilePartInput, PDF → rasterize |
| `container/agent-runner/src/providers/mcp-to-opencode.ts` | null-check `cfg.env`, `cfg.args` |
| `scripts/opencode-injector-proxy.mjs` | nouveau fichier — proxy d'injection |
| `~/.config/systemd/user/openrouter-proxy-host.service` | unit pour le proxy |
| `~/.config/systemd/user/nanoclaw.service` | + `EnvironmentFile=-/home/pegon/nanoclaw/.env` |
| `.env` | + OPENCODE_*, ANTHROPIC_BASE_URL |
| `groups/mattermost_testor/` | dossier complet (container.json, CLAUDE.local.md) |
| `data/mattermost.json` | entry testor |

Tout sauf les unit files systemd et `.env` est versionné dans git (sous le repo).

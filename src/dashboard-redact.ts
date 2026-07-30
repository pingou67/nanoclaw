/**
 * Caviardage de la config de groupe avant publication vers le tableau de bord.
 *
 * Le pousseur envoie `container_config` en entier, et le tableau de bord est
 * un serveur HTTP qui écoute sur `0.0.0.0` : ce qui part d'ici est lisible par
 * qui atteint le port. Or un tableau de bord est une PROJECTION destinée à un
 * humain — il n'a besoin d'aucun credential pour faire son travail. La règle
 * est donc simple : rien de ce qui pourrait être un secret ne sort, et ce qui
 * sort garde assez de forme pour rester lisible.
 *
 * Le cas qui a motivé ce module : l'URL du serveur MCP `ha` porte son jeton
 * dans son CHEMIN (`…/private_<jeton>`). Aucune passerelle ne peut l'injecter,
 * et le journal de démarrage MCP n'imprime déjà que l'`origin` pour cette
 * raison exacte (cf. CLAUDE.md § Secrets). Le tableau de bord, lui, publiait
 * l'URL complète — même secret, même exposition, autre porte.
 *
 * Choix de conception : on ne masque PAS les références de coffre (`vault:…`)
 * ni les marqueurs d'injection (`onecli-injected`). Ce sont des désignations,
 * pas des valeurs, et les laisser visibles donne au tableau de bord une
 * propriété utile — il montre la POSTURE de chaque groupe. Un `<masqué>` y
 * signale alors qu'une valeur brute vit encore en base, ce qui est précisément
 * l'information que l'on veut voir apparaître.
 */

/** Valeurs qui désignent un secret sans le contenir — sûres à afficher. */
const SAFE_MARKERS = [/^vault:/, /^onecli-injected$/, /^$/];

/** Clés dont la valeur est présumée sensible, quel que soit son contenu. */
const SENSITIVE_KEY = /token|key|secret|password|passwd|credential|api[_-]?key/i;

export const MASK = '<masqué>';

function isSafeMarker(value: string): boolean {
  return SAFE_MARKERS.some((re) => re.test(value));
}

/** Masque les valeurs sensibles d'un map d'env, en gardant les désignations. */
export function redactEnv(env: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!env || typeof env !== 'object') return env;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      out[key] = value;
    } else if (isSafeMarker(value) || !SENSITIVE_KEY.test(key)) {
      out[key] = value;
    } else {
      out[key] = MASK;
    }
  }
  return out;
}

/**
 * Réduit une URL à son origine. Un jeton peut vivre dans le chemin, la requête
 * ou les identifiants d'authentification — on ne garde donc que schéma + hôte
 * + port, et on signale qu'il y avait une suite. Une URL non analysable est
 * masquée entièrement : mieux vaut perdre l'affichage que publier au hasard.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MASK;
  }
  const hasMore = (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.username;
  return hasMore ? `${parsed.origin}/${MASK}` : parsed.origin;
}

/** Caviarde un serveur MCP : URL, en-têtes, env. */
export function redactMcpServer(server: unknown): unknown {
  if (!server || typeof server !== 'object') return server;
  const s = { ...(server as Record<string, unknown>) };
  if (typeof s.url === 'string') s.url = redactUrl(s.url);
  if (s.headers && typeof s.headers === 'object') {
    const headers: Record<string, unknown> = {};
    for (const key of Object.keys(s.headers as Record<string, unknown>)) headers[key] = MASK;
    s.headers = headers;
  }
  if (s.env) s.env = redactEnv(s.env as Record<string, unknown>);
  // `args` peut porter un secret en ligne de commande (--token …). On ne sait
  // pas lequel sans deviner, donc on masque tout élément qui ressemble à une
  // valeur opaque plutôt qu'à un drapeau ou un chemin.
  if (Array.isArray(s.args)) {
    s.args = (s.args as unknown[]).map((a) =>
      typeof a === 'string' && /^[A-Za-z0-9_-]{24,}$/.test(a) && !a.startsWith('vault:') ? MASK : a,
    );
  }
  return s;
}

/**
 * Caviarde la config d'un groupe telle qu'elle est publiée. Les colonnes JSON
 * illisibles sont remplacées par `null` : un JSON cassé est une anomalie de
 * config, pas une raison de publier une chaîne brute non inspectée.
 */
export function redactContainerConfig<T extends { mcp_servers?: unknown; env?: unknown }>(config: T | null): T | null {
  if (!config) return config;
  const out = { ...config } as Record<string, unknown>;

  if (typeof config.mcp_servers === 'string') {
    try {
      const servers = JSON.parse(config.mcp_servers) as Record<string, unknown>;
      const redacted: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(servers)) redacted[name] = redactMcpServer(server);
      out.mcp_servers = JSON.stringify(redacted);
    } catch {
      out.mcp_servers = null;
    }
  }

  if (typeof config.env === 'string') {
    try {
      out.env = JSON.stringify(redactEnv(JSON.parse(config.env) as Record<string, unknown>));
    } catch {
      out.env = null;
    }
  }

  return out as T;
}

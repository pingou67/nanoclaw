/**
 * Conversion de NOTRE `McpServerConfig` (permissif : `command` optionnel depuis
 * le support des serveurs MCP distants) vers les deux formes que codex sait
 * écrire dans son config.toml.
 *
 * Ce qui est réellement en jeu : un serveur MCP écarté ne se manifeste que par
 * des outils qui n'existent pas. Sous kimi, ce mode de panne nous a coûté un
 * long diagnostic (2026-07-28). Exigence testée ici : la bonne
 * forme est émise pour chaque cas représentable.
 */
import { describe, expect, it } from 'bun:test';

import { toCodexMcpServers } from './codex.js';

describe('toCodexMcpServers', () => {
  it('émet la forme distante pour un serveur à url (cas ha-mcp)', () => {
    const out = toCodexMcpServers({ ha: { type: 'http', url: 'http://192.168.1.113:9583/private_xyz' } });
    expect(out).toEqual({ ha: { url: 'http://192.168.1.113:9583/private_xyz' } });
  });

  it('émet la forme stdio pour un serveur à command', () => {
    const out = toCodexMcpServers({ vikunja: { command: 'bun', args: ['run', 'x.ts'], env: { A: 'b' } } });
    expect(out).toEqual({ vikunja: { command: 'bun', args: ['run', 'x.ts'], env: { A: 'b' } } });
  });

  it('ne mélange jamais les deux formes', () => {
    const out = toCodexMcpServers({
      distant: { type: 'http', url: 'https://x.test/mcp' },
      local: { command: 'bun' },
    });
    expect(out.distant).not.toHaveProperty('command');
    expect(out.local).not.toHaveProperty('url');
  });

  // Les deux tests de rejet (en-têtes personnalisés, « ni command ni url »)
  // ont été retirés le 2026-08-11 avec leur cause : l'union upstream rend ces
  // deux formes INEXPRIMABLES, le typage les interdit avant l'exécution. Si
  // `headers` revenait un jour côté cœur, rétablir le rejet NOMMÉ sur stderr
  // en même temps que le champ — un MCP droppé en silence ne se manifeste que
  // par des outils absents (diagnostic coûteux sous kimi, 2026-07-28).

  // Le bloc env d'un stdio REMPLACE l'environnement côté codex. Sans
  // réinjection, le serveur sort du périmètre du proxy OneCLI : celui dont le
  // secret voyage dans un en-tête prend un 401, plante, et codex l'écarte —
  // panne visible seulement par des outils absents (vécu le 2026-08-12).
  describe('environnement réseau hérité', () => {
    const PROXY = { HTTPS_PROXY: 'http://x:tok@gw:10255', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' };

    it('réinjecte proxy et CA dans un serveur stdio qui n’a pas d’env', () => {
      const out = toCodexMcpServers({ vikunja: { command: 'bun' } }, PROXY);
      expect(out.vikunja).toEqual({ command: 'bun', env: PROXY });
    });

    it('fusionne avec l’env du groupe sans l’écraser', () => {
      const out = toCodexMcpServers({ vikunja: { command: 'bun', env: { VIKUNJA_URL: 'https://v.test' } } }, PROXY);
      expect(out.vikunja).toEqual({ command: 'bun', env: { ...PROXY, VIKUNJA_URL: 'https://v.test' } });
    });

    it('laisse le groupe surcharger une variable héritée', () => {
      const out = toCodexMcpServers({ s: { command: 'bun', env: { HTTPS_PROXY: 'http://direct' } } }, PROXY);
      expect((out.s as { env: Record<string, string> }).env.HTTPS_PROXY).toBe('http://direct');
    });

    it('n’ajoute rien à un serveur distant — codex ouvre lui-même la connexion', () => {
      const out = toCodexMcpServers({ ha: { type: 'http', url: 'https://x.test/mcp' } }, PROXY);
      expect(out.ha).toEqual({ url: 'https://x.test/mcp' });
    });

    it('n’invente pas de variable absente du parent', () => {
      const out = toCodexMcpServers({ s: { command: 'bun' } }, {});
      expect(out.s).toEqual({ command: 'bun' });
    });
  });

  it('ne perd aucun serveur : tout ce qui est représentable est traduit', () => {
    const out = toCodexMcpServers({
      distant: { type: 'http', url: 'https://x.test/mcp' },
      local: { command: 'bun', args: ['run', 'x.ts'] },
      minimal: { command: 'node' },
    });
    expect(Object.keys(out).sort()).toEqual(['distant', 'local', 'minimal']);
  });
});

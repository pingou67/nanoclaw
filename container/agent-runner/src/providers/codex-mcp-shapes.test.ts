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

  it('ne perd aucun serveur : tout ce qui est représentable est traduit', () => {
    const out = toCodexMcpServers({
      distant: { type: 'http', url: 'https://x.test/mcp' },
      local: { command: 'bun', args: ['run', 'x.ts'] },
      minimal: { command: 'node' },
    });
    expect(Object.keys(out).sort()).toEqual(['distant', 'local', 'minimal']);
  });
});

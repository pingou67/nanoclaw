/**
 * Conversion de NOTRE `McpServerConfig` (permissif : `command` optionnel depuis
 * le support des serveurs MCP distants) vers les deux formes que codex sait
 * écrire dans son config.toml.
 *
 * Ce qui est réellement en jeu : un serveur MCP écarté ne se manifeste que par
 * des outils qui n'existent pas. Sous kimi, ce mode de panne nous a coûté un
 * long diagnostic (2026-07-28). D'où deux exigences testées ici — la bonne
 * forme est émise, et tout écart est NOMMÉ sur stderr.
 */
import { describe, expect, it, spyOn } from 'bun:test';

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

  it('écarte un distant à en-têtes personnalisés — et le NOMME', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const out = toCodexMcpServers({
      avecEntetes: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer z' } },
    });
    expect(out).toEqual({});
    const msg = err.mock.calls.flat().join(' ');
    expect(msg).toContain('avecEntetes'); // le nom du serveur, pas un message générique
    expect(msg).toContain('Authorization');
    err.mockRestore();
  });

  it('écarte — en le nommant — un serveur qui n’a ni command ni url', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    expect(toCodexMcpServers({ vide: {} })).toEqual({});
    expect(err.mock.calls.flat().join(' ')).toContain('vide');
    err.mockRestore();
  });

  it('un en-têtes vide n’est pas un en-têtes — le serveur passe', () => {
    expect(toCodexMcpServers({ ok: { type: 'http', url: 'https://x.test/mcp', headers: {} } })).toEqual({
      ok: { url: 'https://x.test/mcp' },
    });
  });
});

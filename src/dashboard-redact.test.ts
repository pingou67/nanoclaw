/**
 * Le tableau de bord écoute sur 0.0.0.0 : ce qui lui est poussé est lisible par
 * qui atteint le port. Ces tests fixent les deux moitiés du contrat — rien de
 * secret ne sort, et ce qui sort reste assez lisible pour être utile.
 */
import { describe, expect, it } from 'vitest';

import { MASK, redactContainerConfig, redactEnv, redactMcpServer, redactUrl } from './dashboard-redact.js';

describe('redactUrl', () => {
  it('réduit à l’origine une URL dont le CHEMIN porte le jeton (cas ha)', () => {
    // Le secret est dans le chemin : aucune passerelle ne peut l'injecter, et
    // c'est déjà la raison pour laquelle le log MCP n'imprime que l'origin.
    expect(redactUrl('http://192.168.1.113:9583/private_abcdef123456')).toBe(`http://192.168.1.113:9583/${MASK}`);
  });

  it('masque aussi la requête et les identifiants d’authentification', () => {
    expect(redactUrl('https://api.example.com/?token=abc')).toBe(`https://api.example.com/${MASK}`);
    expect(redactUrl('https://user:pw@api.example.com')).toBe(`https://api.example.com/${MASK}`);
  });

  it('laisse une origine nue telle quelle — elle ne révèle rien', () => {
    expect(redactUrl('https://vikunja.pegs.fr')).toBe('https://vikunja.pegs.fr');
  });

  it('masque entièrement ce qu’il ne sait pas analyser plutôt que de deviner', () => {
    expect(redactUrl('pas-une-url')).toBe(MASK);
  });
});

describe('redactEnv', () => {
  it('masque une valeur brute sous une clé sensible', () => {
    expect(redactEnv({ VIKUNJA_TOKEN: 'tk_reelvaleur' })).toEqual({ VIKUNJA_TOKEN: MASK });
  });

  it('garde les DÉSIGNATIONS — c’est ce qui rend la posture lisible', () => {
    // Une référence de coffre et un marqueur d'injection ne contiennent aucun
    // secret ; les afficher permet de voir d'un coup d'œil quels groupes sont
    // sur la bonne voie, et un `<masqué>` signale l'inverse.
    expect(redactEnv({ OPENCODE_API_KEY: 'vault:opencode_go/api_key', VIKUNJA_TOKEN: 'onecli-injected' })).toEqual({
      OPENCODE_API_KEY: 'vault:opencode_go/api_key',
      VIKUNJA_TOKEN: 'onecli-injected',
    });
  });

  it('ne touche pas aux valeurs de configuration ordinaires', () => {
    expect(redactEnv({ VIKUNJA_URL: 'https://vikunja.pegs.fr', HOME: '/workspace/extra' })).toEqual({
      VIKUNJA_URL: 'https://vikunja.pegs.fr',
      HOME: '/workspace/extra',
    });
  });
});

describe('redactMcpServer', () => {
  it('caviarde url, en-têtes et env d’un même serveur', () => {
    const out = redactMcpServer({
      type: 'http',
      url: 'http://192.168.1.113:9583/private_xyz',
      headers: { Authorization: 'Bearer reel' },
      env: { API_KEY: 'sk-reel' },
    }) as Record<string, unknown>;
    expect(out.url).toBe(`http://192.168.1.113:9583/${MASK}`);
    expect(out.headers).toEqual({ Authorization: MASK });
    expect(out.env).toEqual({ API_KEY: MASK });
    expect(out.type).toBe('http');
  });

  it('masque un argument opaque sans toucher aux drapeaux ni aux chemins', () => {
    const out = redactMcpServer({
      command: 'srv',
      args: ['--token', 'A1b2C3d4E5f6G7h8I9j0K1l2', '/workspace/extra/creds.json', '--verbose'],
    }) as Record<string, unknown>;
    expect(out.args).toEqual(['--token', MASK, '/workspace/extra/creds.json', '--verbose']);
  });
});

describe('redactContainerConfig', () => {
  it('caviarde les colonnes JSON en préservant le reste de la ligne', () => {
    const out = redactContainerConfig({
      agent_group_id: 'ag-x',
      provider: 'claude',
      mcp_servers: JSON.stringify({
        ha: { url: 'http://h:1/private_tok' },
        vikunja: { env: { VIKUNJA_TOKEN: 'tk_x' } },
      }),
      env: JSON.stringify({ OPENCODE_API_KEY: 'vault:opencode_go/api_key', ANTHROPIC_AUTH_TOKEN: 'sk-reel' }),
    });
    const servers = JSON.parse(out!.mcp_servers as string);
    expect(servers.ha.url).toBe(`http://h:1/${MASK}`);
    expect(servers.vikunja.env.VIKUNJA_TOKEN).toBe(MASK);
    expect(JSON.parse(out!.env as string)).toEqual({
      OPENCODE_API_KEY: 'vault:opencode_go/api_key',
      ANTHROPIC_AUTH_TOKEN: MASK,
    });
    expect(out!.provider).toBe('claude');
  });

  it('remplace par null un JSON illisible plutôt que de publier la chaîne brute', () => {
    const out = redactContainerConfig({ agent_group_id: 'ag-x', mcp_servers: '{cassé', env: '{cassé' });
    expect(out!.mcp_servers).toBeNull();
    expect(out!.env).toBeNull();
  });

  it('accepte une config absente', () => {
    expect(redactContainerConfig(null)).toBeNull();
  });
});

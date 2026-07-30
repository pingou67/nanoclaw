import { describe, expect, it } from 'vitest';

import { deriveAccessRights, maxContextForModel } from './dashboard-usage.js';

describe('maxContextForModel', () => {
  it('maps known model families and falls back to 200k', () => {
    expect(maxContextForModel('minimax-m3')).toBe(1_000_000);
    expect(maxContextForModel('gemini-3-pro')).toBe(1_048_576);
    expect(maxContextForModel('claude-opus-4')).toBe(200_000);
  });
});

describe('deriveAccessRights', () => {
  it('derives rights from mcp servers, mounts and cli_scope', () => {
    const rights = deriveAccessRights({
      mcp_servers: JSON.stringify({
        nanoclaw: {},
        'gmail-perso': { env: {} },
        'google-calendar': { instructions: 'calendrier Famille en écriture, les autres en LECTURE SEULE' },
        imap: { accounts: [{ name: 'unistra', host: 'partage.example', passwordRef: 'vault:mail_unistra' }] },
        vikunja: { env: { VIKUNJA_PROJECT_SCOPE: 'WORK' } },
        memory: {},
        'brave-search': {},
      }),
      additional_mounts: JSON.stringify([
        { hostPath: '/mnt/home/x/DEV', containerPath: '/workspace/extra/dev', readonly: false },
      ]),
      cli_scope: 'global',
    });
    expect(rights).toContain('Gmail perso (complet)');
    expect(rights).toContain('Google Calendar (restreint PAR INSTRUCTIONS — non garanti techniquement)');
    expect(rights).toContain('Mail Unistra (imap)');
    expect(rights).toContain('Vikunja (projet WORK)');
    expect(rights).toContain('Mémoire persistante');
    expect(rights).toContain('MCP brave-search');
    expect(rights).toContain('Mount RW /mnt/home/x/DEV');
    expect(rights).toContain('ncl GLOBAL (admin complet)');
    expect(rights.some((r) => r.includes('nanoclaw'))).toBe(false);
  });

  it('shows the [résumé: …] summary verbatim when present', () => {
    const rights = deriveAccessRights({
      mcp_servers: JSON.stringify({
        'google-calendar': {
          instructions: '[résumé: écriture = Famille uniquement ; lecture seule = les autres] Règle détaillée…',
        },
      }),
      additional_mounts: '[]',
      cli_scope: 'group',
    });
    expect(rights[0]).toBe(
      'Google Calendar — écriture = Famille uniquement ; lecture seule = les autres (PAR INSTRUCTIONS, non garanti techniquement)',
    );
  });

  // Depuis le passage au coffre, les credentials imap sont générés au spawn :
  // ce qui manque n'est plus un mount mais la DÉCLARATION du compte. Un
  // `passwordRef` absent est le seul cas où le serveur démarre sans credential
  // — une référence de coffre illisible, elle, fait échouer le spawn.
  it('signale un serveur imap sans compte déclaré', () => {
    const rights = deriveAccessRights({
      mcp_servers: JSON.stringify({ imap: {} }),
      additional_mounts: '[]',
      cli_scope: 'group',
    });
    expect(rights[0]).toContain('⚠ aucun compte déclaré');
  });

  it('ne signale rien quand le compte est déclaré, sans mount permanent', () => {
    const rights = deriveAccessRights({
      mcp_servers: JSON.stringify({
        imap: { accounts: [{ name: 'unistra', host: 'partage.example', passwordRef: 'vault:mail_unistra' }] },
      }),
      additional_mounts: '[]',
      cli_scope: 'group',
    });
    expect(rights[0]).toBe('Mail Unistra (imap)');
  });

  it('ignore un mount .imap-mcp hérité d’avant le coffre', () => {
    const rights = deriveAccessRights({
      mcp_servers: '{}',
      additional_mounts: JSON.stringify([{ hostPath: '/home/x/.imap-mcp', containerPath: '.imap-mcp', readonly: true }]),
      cli_scope: 'group',
    });
    expect(rights).toEqual([]);
  });
});

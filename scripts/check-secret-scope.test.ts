/**
 * L'audit doit voir les DEUX sens de la dérive : un secret porté sans besoin,
 * et un besoin déclaré sans secret. Le second est plus insidieux — il ne
 * ressemble pas à un problème de sécurité, il se manifeste par un 401 lointain.
 */
import { describe, expect, it } from 'vitest';

import { auditScope, identifierForGroup } from './check-secret-scope.js';

const REQUIRED_BY = { Vikunja: 'vikunja' };

describe('identifierForGroup', () => {
  it('reproduit la convention d’ensureAgent (underscores -> tirets)', () => {
    expect(identifierForGroup('ag-mattermost_work')).toBe('ag-mattermost-work');
    expect(identifierForGroup('ag-mattermost_testor-claude')).toBe('ag-mattermost-testor-claude');
  });
});

describe('auditScope', () => {
  const needs = { 'ag-mattermost_work': ['imap', 'vikunja'], 'ag-mattermost_coding': [] };

  it('accepte un périmètre qui colle au besoin', () => {
    const findings = auditScope(
      [
        { identifier: 'ag-mattermost-work', secretMode: 'selective', secrets: ['Vikunja'] },
        { identifier: 'ag-mattermost-coding', secretMode: 'selective', secrets: [] },
      ],
      needs,
      REQUIRED_BY,
    );
    expect(findings.filter((f) => f.level === 'écart')).toEqual([]);
  });

  it('signale un secret porté sans le serveur MCP qui le justifie', () => {
    const findings = auditScope(
      [{ identifier: 'ag-mattermost-coding', secretMode: 'selective', secrets: ['Vikunja'] }],
      needs,
      REQUIRED_BY,
    );
    expect(findings).toContainEqual(expect.objectContaining({ level: 'écart', message: expect.stringMatching(/sans le serveur MCP/) }));
  });

  it('signale l’inverse : le besoin est là, l’injection ne suivra pas', () => {
    const findings = auditScope(
      [{ identifier: 'ag-mattermost-work', secretMode: 'selective', secrets: [] }],
      needs,
      REQUIRED_BY,
    );
    expect(findings).toContainEqual(expect.objectContaining({ level: 'écart', message: expect.stringMatching(/401/) }));
  });

  it('traite le mode « all » comme un écart, sans chercher plus loin', () => {
    const findings = auditScope(
      [{ identifier: 'ag-mattermost-coding', secretMode: 'all', secrets: ['Vikunja'] }],
      needs,
      REQUIRED_BY,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'écart', message: expect.stringMatching(/mode « all »/) });
  });

  it('distingue l’agent orphelin inoffensif de celui qui porte encore un secret', () => {
    const armed = auditScope([{ identifier: 'disparu', secretMode: 'selective', secrets: ['Vikunja'] }], needs, REQUIRED_BY);
    expect(armed[0]).toMatchObject({ level: 'écart', message: expect.stringMatching(/orphelin/) });

    const harmless = auditScope([{ identifier: 'disparu', secretMode: 'selective', secrets: [] }], needs, REQUIRED_BY);
    expect(harmless[0].level).toBe('info');
  });

  it('ne prétend pas auditer un secret que le manifeste n’explique pas', () => {
    const findings = auditScope(
      [{ identifier: 'ag-mattermost-coding', secretMode: 'selective', secrets: ['Inconnu'] }],
      needs,
      { Inconnu: undefined },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('info');
  });
});

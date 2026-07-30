import { describe, expect, it } from 'vitest';

import { loadMapping, rbwArgsFor } from './sync-vault-to-onecli.js';

describe('loadMapping', () => {
  it('ignore la clé de commentaire et les entrées sans référence', () => {
    const map = loadMapping(
      JSON.stringify({ '//': 'doc', Vikunja: { vaultRef: 'vikunja/token' }, Cassé: { note: 'sans vaultRef' } }),
    );
    expect(Object.keys(map)).toEqual(['Vikunja']);
    expect(map.Vikunja.vaultRef).toBe('vikunja/token');
  });
});

describe('rbwArgsFor', () => {
  it('utilise --field quand un champ est précisé', () => {
    expect(rbwArgsFor('vikunja/token')).toEqual(['get', 'vikunja', '--field', 'token']);
  });

  it('retombe sur le mot de passe de l’élément sans champ', () => {
    expect(rbwArgsFor('mail_unistra')).toEqual(['get', 'mail_unistra']);
  });

  it('ne coupe qu’au premier slash', () => {
    expect(rbwArgsFor('svc/a/b')).toEqual(['get', 'svc', '--field', 'a/b']);
  });
});

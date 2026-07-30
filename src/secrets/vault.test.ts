/**
 * Le contrat de la branche « non-HTTP » de la doctrine secrets : une valeur de
 * configuration peut être une RÉFÉRENCE au coffre plutôt qu'un secret en clair,
 * et une référence illisible doit faire ÉCHOUER bruyamment — jamais produire
 * une variable vide qui casserait plus tard, ailleurs, sans rapport apparent.
 */
import { describe, expect, it } from 'vitest';

import { hasVaultRefs, parseVaultRef, resolveVaultRefs, VAULT_PREFIX } from './vault.js';

describe('parseVaultRef', () => {
  it('reconnaît élément seul et élément/champ', () => {
    expect(parseVaultRef('vault:mail_unistra')).toEqual({ item: 'mail_unistra' });
    expect(parseVaultRef('vault:vikunja/token')).toEqual({ item: 'vikunja', field: 'token' });
  });

  it('accepte un champ contenant des slashs (le 1er sépare)', () => {
    expect(parseVaultRef('vault:svc/a/b')).toEqual({ item: 'svc', field: 'a/b' });
  });

  it('ignore ce qui n’est pas une référence', () => {
    expect(parseVaultRef('tk_valeur_en_clair')).toBeNull();
    expect(parseVaultRef('')).toBeNull();
    expect(parseVaultRef('https://vault.example/x')).toBeNull();
  });

  it('refuse une référence tronquée plutôt que d’en deviner le sens', () => {
    expect(parseVaultRef(VAULT_PREFIX)).toBeNull();
    expect(parseVaultRef('vault:/token')).toBeNull();
    expect(parseVaultRef('vault:item/')).toBeNull();
  });
});

describe('hasVaultRefs', () => {
  it('détecte au moins une référence dans un map d’env', () => {
    expect(hasVaultRefs({ A: 'x', B: 'vault:item' })).toBe(true);
    expect(hasVaultRefs({ A: 'x' })).toBe(false);
    expect(hasVaultRefs(undefined)).toBe(false);
  });
});

describe('resolveVaultRefs', () => {
  it('ne remplace QUE les références, les autres valeurs passent intactes', () => {
    const out = resolveVaultRefs(
      { URL: 'https://v.example', TOKEN: 'vault:vikunja/token' },
      (r) => `<${r.item}:${r.field}>`,
    );
    expect(out).toEqual({ URL: 'https://v.example', TOKEN: '<vikunja:token>' });
  });

  it('propage l’échec de lecture au lieu de produire une valeur vide', () => {
    // C'est le point : l'appelant refuse le spawn. Un container qui démarre
    // avec un secret vide échoue plus tard, ailleurs, de façon illisible.
    expect(() =>
      resolveVaultRefs({ TOKEN: 'vault:absent' }, () => {
        throw new Error('coffre: « absent » illisible');
      }),
    ).toThrow(/absent/);
  });

  it('n’appelle pas le coffre quand aucune référence n’est présente', () => {
    let calls = 0;
    resolveVaultRefs({ A: '1', B: '2' }, () => {
      calls++;
      return 'x';
    });
    expect(calls).toBe(0);
  });
});

/**
 * Le CLI onecli a changé de forme de sortie entre 1.x (tableau nu) et 2.x
 * ({hint, data}). La montée du pin le 2026-08-03 a cassé d'un coup les deux
 * scripts d'audit des secrets. Ces tests fixent la tolérance aux deux formes —
 * et surtout le refus de rendre une liste vide sur une sortie inconnue, qu'un
 * appelant lirait comme « aucun secret », donc « rien à auditer ».
 */
import { describe, expect, it } from 'vitest';

import { unwrapOnecliJson } from './onecli-cli.js';

describe('unwrapOnecliJson', () => {
  it('accepte le tableau nu de onecli-cli 1.x', () => {
    expect(unwrapOnecliJson<{ id: string }>('[{"id":"a"},{"id":"b"}]')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('déballe l’enveloppe {hint, data} de onecli-cli 2.x', () => {
    const raw = '{"hint":"Manage your secrets → http://127.0.0.1:10254","data":[{"id":"a"}]}';
    expect(unwrapOnecliJson<{ id: string }>(raw)).toEqual([{ id: 'a' }]);
  });

  it('gère les deux formes vides sans les confondre avec une erreur', () => {
    expect(unwrapOnecliJson('[]')).toEqual([]);
    expect(unwrapOnecliJson('{"hint":"x","data":[]}')).toEqual([]);
  });

  it('déballe aussi un tableau de chaînes (agents secrets rend des ids)', () => {
    expect(unwrapOnecliJson<string>('{"hint":"x","data":["id-1","id-2"]}')).toEqual(['id-1', 'id-2']);
  });

  it('LÈVE sur une forme inconnue plutôt que de rendre une liste vide', () => {
    // Le mode d'échec dangereux : un audit qui ne voit rien conclut « conforme ».
    expect(() => unwrapOnecliJson('{"error":"unknown flag","code":"ERROR"}')).toThrow(/inattendue/);
    expect(() => unwrapOnecliJson('{"data":{"not":"an array"}}')).toThrow(/inattendue/);
    expect(() => unwrapOnecliJson('null')).toThrow(/inattendue/);
  });
});

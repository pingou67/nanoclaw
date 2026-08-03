/**
 * Appels au binaire CLI `onecli`, et surtout : lecture de sa sortie JSON.
 *
 * ── Pourquoi ce module existe ─────────────────────────────────────────────
 *
 * Le CLI a changé de forme de sortie entre deux versions majeures :
 *
 *   onecli-cli 1.x   →  [ {...}, {...} ]                    (tableau nu)
 *   onecli-cli 2.x   →  { "hint": "…", "data": [ … ] }      (enveloppe)
 *
 * Le 2026-08-03, la montée 1.1.0 → 2.2.5 (pin `onecli-cli` de `versions.json`)
 * a cassé d'un coup `check-secret-scope.ts` et `sync-vault-to-onecli.ts`, qui
 * faisaient tous deux `JSON.parse(...) as T[]`. Le premier est le garde-fou de
 * la doctrine secrets : le voir mourir sur un `TypeError` est bénin, mais
 * l'aurait-il fait en silence que le périmètre aurait dérivé sans témoin.
 *
 * `onecliJson` accepte donc les DEUX formes. Ce n'est pas de la complaisance
 * envers un format instable : c'est reconnaître qu'un outil externe versionné
 * séparément peut bouger sous nos pieds, et qu'un script d'audit doit survivre
 * à ça plutôt que de rendre l'audit indisponible.
 */
import { execFileSync } from 'child_process';

/** Exécute `onecli <args>` et renvoie sa sortie brute. */
export function onecli(args: string[]): string {
  return execFileSync(process.env.ONECLI_BIN || 'onecli', args, { encoding: 'utf-8', timeout: 60_000 });
}

/**
 * Déballe la sortie JSON du CLI, quelle que soit sa forme (voir l'en-tête).
 *
 * Exporté séparément de `onecliJson` pour être testable sans binaire.
 */
export function unwrapOnecliJson<T>(raw: string): T[] {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: T[] }).data;
  }
  // Ni l'une ni l'autre : mieux vaut échouer bruyamment que rendre une liste
  // vide, qu'un appelant lirait comme « aucun secret » — donc « rien à auditer ».
  throw new Error(`Sortie onecli inattendue : ni tableau, ni { data: [...] } — reçu ${raw.slice(0, 120)}`);
}

/** `onecli <args>` + parsing + déballage. */
export function onecliJson<T>(args: string[]): T[] {
  return unwrapOnecliJson<T>(onecli(args));
}

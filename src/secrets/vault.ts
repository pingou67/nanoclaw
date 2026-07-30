/**
 * Accès au coffre Bitwarden/Vaultwarden via `rbw`, pour les secrets qu'OneCLI
 * ne peut PAS couvrir.
 *
 * Partage des rôles (cf. CLAUDE.md § Secrets) :
 *   - secret qui voyage dans un en-tête HTTP  -> OneCLI réécrit l'en-tête, le
 *     container ne voit jamais la valeur. Source de vérité : le coffre, poussé
 *     vers OneCLI par `scripts/sync-vault-to-onecli.ts`.
 *   - tout le reste (IMAP, fichiers, protocoles non-HTTP) -> résolution ICI, au
 *     spawn, côté hôte. La valeur entre alors dans le container et devient
 *     lisible par l'agent : c'est inévitable, et c'est pourquoi cette voie est
 *     le second choix, jamais le premier.
 *
 * `rbw` est appelé en sous-processus : la valeur revient sur stdout (jamais sur
 * une ligne de commande, donc invisible dans `ps`) et n'est ni journalisée ni
 * réécrite sur disque par ce module.
 */
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

/** Préfixe d'une référence de coffre dans une valeur de configuration. */
export const VAULT_PREFIX = 'vault:';

export interface VaultRef {
  item: string;
  /** Champ personnalisé ; absent = le mot de passe de l'élément. */
  field?: string;
}

/** `vault:élément/champ` -> { item, field }. Null si ce n'est pas une référence. */
export function parseVaultRef(value: string): VaultRef | null {
  if (!value.startsWith(VAULT_PREFIX)) return null;
  const raw = value.slice(VAULT_PREFIX.length).trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  if (slash === -1) return { item: raw };
  const item = raw.slice(0, slash);
  const field = raw.slice(slash + 1);
  if (!item || !field) return null;
  return { item, field };
}

/** True si au moins une valeur du map est une référence de coffre. */
export function hasVaultRefs(env: Record<string, string> | undefined): boolean {
  return Object.values(env ?? {}).some((v) => typeof v === 'string' && v.startsWith(VAULT_PREFIX));
}

function rbwBin(): string {
  return process.env.RBW_BIN || path.join(os.homedir(), '.local', 'bin', 'rbw');
}

/**
 * Lit une valeur du coffre. Lève une erreur nommant la RÉFÉRENCE (jamais la
 * valeur) — le message remonte dans les logs du host, qui sont durables.
 */
export function readVaultSecret(ref: VaultRef): string {
  const args = ['get', ref.item, ...(ref.field ? ['--field', ref.field] : [])];
  let out: string;
  try {
    out = execFileSync(rbwBin(), args, { encoding: 'utf-8', timeout: 30_000 });
  } catch (e) {
    const reason =
      e instanceof Error && /ENOENT/.test(e.message)
        ? 'binaire rbw introuvable'
        : 'coffre verrouillé ou élément absent';
    throw new Error(`coffre: « ${ref.item}${ref.field ? '/' + ref.field : ''} » illisible (${reason})`);
  }
  // rbw ajoute un saut de ligne final ; un secret ne commence/finit pas par un
  // blanc, mais on ne trim QUE les fins de ligne pour ne pas altérer la valeur.
  const value = out.replace(/\r?\n$/, '');
  if (!value) throw new Error(`coffre: « ${ref.item}${ref.field ? '/' + ref.field : ''} » est vide`);
  return value;
}

/**
 * Remplace toute valeur `vault:…` d'un map d'env par sa valeur réelle. Les
 * autres valeurs passent inchangées. Lève à la PREMIÈRE référence illisible :
 * l'appelant refuse alors le spawn, plutôt que de démarrer un container avec
 * une variable vide qui échouerait plus tard, ailleurs, sans rapport apparent.
 */
export function resolveVaultRefs(
  env: Record<string, string>,
  read: (ref: VaultRef) => string = readVaultSecret,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const ref = typeof value === 'string' ? parseVaultRef(value) : null;
    out[key] = ref ? read(ref) : value;
  }
  return out;
}

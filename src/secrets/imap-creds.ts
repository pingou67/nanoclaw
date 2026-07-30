/**
 * Matérialise les credentials d'`imap-mcp-server` au spawn, depuis le coffre.
 *
 * Pourquoi ce module existe : le mot de passe Unistra ne peut être livré ni par
 * OneCLI (l'IMAP n'est pas du HTTP — l'authentification voyage dans le flux du
 * protocole, il n'y a aucun en-tête à réécrire) ni par une variable
 * d'environnement (le serveur ne lit QUE `$HOME/.imap-mcp/accounts.json` ; ses
 * seules variables `IMAP_*` concernent les téléchargements et le mode lecture
 * seule). Restait donc à générer le fichier lui-même.
 *
 * Avant : un `accounts.json` permanent sur l'hôte, avec sa clé de déchiffrement
 * dans le MÊME dossier — le chiffrement AES n'y ajoutait rien face à un accès
 * au dossier, la protection réelle venait des permissions.
 * Après : plus aucun fichier de credential permanent. Le mot de passe vit dans
 * le coffre ; à chaque spawn on écrit un couple {accounts.json, .key} éphémère
 * dans le dossier de session, avec une clé tirée au hasard à chaque fois.
 *
 * ⚠️ Ce module REPRODUIT le format interne d'imap-mcp-server (aes-256-cbc,
 * `iv:ciphertext` en hex, clé de 32 octets en hex dans `.key`). C'est un format
 * non documenté : `imapCredsRoundTrip` dans les tests vérifie qu'on sait
 * relire ce qu'on écrit, et la suite E2E (`mcp imap @#work`) est le vrai
 * garde-fou de bout en bout. À revérifier à chaque bump du paquet.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { readVaultSecret, type VaultRef } from './vault.js';

/** Partie NON secrète du compte — vit dans la config, pas dans le coffre. */
export interface ImapAccountSpec {
  /** Nom du compte tel que l'agent l'emploie (`account: "unistra"`). */
  name: string;
  host: string;
  port: number;
  user: string;
  tls: boolean;
  /** Référence de coffre du mot de passe (`vault:mail_unistra`). */
  passwordRef: string;
  /** Identifiant stable du compte, pour ne pas le régénérer à chaque spawn. */
  id: string;
}

/**
 * Extrait les comptes imap déclarés par un groupe. La partie non secrète vit
 * dans `mcp_servers.imap.accounts` (config, lisible) ; seul le mot de passe est
 * une référence de coffre. Retourne [] si le groupe n'a pas de serveur imap —
 * c'est ce qui garantit qu'aucun credential n'est matérialisé pour un groupe
 * qui n'en a pas l'usage (règle de moindre exposition).
 */
export function imapAccountSpecs(config: { mcpServers?: Record<string, unknown> }): ImapAccountSpec[] {
  const imap = config.mcpServers?.imap as { accounts?: unknown } | undefined;
  if (!imap || !Array.isArray(imap.accounts)) return [];
  return (imap.accounts as ImapAccountSpec[]).filter(
    (a) => a && typeof a.name === 'string' && typeof a.host === 'string' && typeof a.passwordRef === 'string',
  );
}

/** Chiffre comme imap-mcp-server : `iv(hex):ciphertext(hex)`, aes-256-cbc. */
export function encryptForImapMcp(plain: string, keyHex: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
  return iv.toString('hex') + ':' + cipher.update(plain, 'utf8', 'hex') + cipher.final('hex');
}

/** Déchiffre le même format — utilisé par les tests pour boucler la boucle. */
export function decryptFromImapMcp(payload: string, keyHex: string): string {
  const [ivHex, encrypted] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

/** Le `accounts.json` attendu par le serveur, mot de passe déjà chiffré. */
export function buildAccountsJson(specs: ImapAccountSpec[], passwords: string[], keyHex: string): string {
  const accounts = specs.map((s, i) => ({
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.user,
    password: encryptForImapMcp(passwords[i], keyHex),
    tls: s.tls,
  }));
  return JSON.stringify(accounts, null, 2);
}

/**
 * Écrit {accounts.json, .key} dans `dir` et retourne le chemin du dossier.
 * Clé tirée au hasard à CHAQUE appel : deux sessions ne partagent jamais la
 * même, et une fuite d'un couple ne compromet pas les autres.
 */
export function materializeImapCreds(
  dir: string,
  specs: ImapAccountSpec[],
  read: (ref: VaultRef) => string = readVaultSecret,
): string {
  const passwords = specs.map((s) => {
    const raw = s.passwordRef.startsWith('vault:') ? s.passwordRef.slice('vault:'.length) : s.passwordRef;
    const slash = raw.indexOf('/');
    return read(slash === -1 ? { item: raw } : { item: raw.slice(0, slash), field: raw.slice(slash + 1) });
  });

  const keyHex = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  // 0600 explicite : `mode` de writeFileSync ne s'applique qu'à la création, et
  // ce dossier est réécrit à chaque spawn.
  const accountsPath = path.join(dir, 'accounts.json');
  const keyPath = path.join(dir, '.key');
  fs.writeFileSync(accountsPath, buildAccountsJson(specs, passwords, keyHex), { mode: 0o600 });
  fs.writeFileSync(keyPath, keyHex, { mode: 0o600 });
  fs.chmodSync(accountsPath, 0o600);
  fs.chmodSync(keyPath, 0o600);

  return dir;
}

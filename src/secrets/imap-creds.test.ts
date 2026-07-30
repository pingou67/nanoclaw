/**
 * Ce module reproduit un format INTERNE et non documenté d'imap-mcp-server
 * (aes-256-cbc, `iv:ciphertext` hex, clé 32 octets hex). Ces tests bouclent la
 * boucle — on relit ce qu'on écrit — et verrouillent les propriétés qui font la
 * sécurité du dispositif : permissions 0600/0700 et clé jamais réutilisée.
 * Le vrai garde-fou de bout en bout reste l'E2E (`mcp imap @#work`).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildAccountsJson,
  decryptFromImapMcp,
  encryptForImapMcp,
  materializeImapCreds,
  type ImapAccountSpec,
} from './imap-creds.js';

const KEY = 'a'.repeat(64); // 32 octets en hex

const spec: ImapAccountSpec = {
  id: 'id-1',
  name: 'unistra',
  host: 'partage.unistra.fr',
  port: 993,
  user: 'pegon@unistra.fr',
  tls: true,
  passwordRef: 'vault:mail_unistra',
};

describe('format de chiffrement', () => {
  it('produit `iv:ciphertext` en hex et se relit', () => {
    const payload = encryptForImapMcp('mot-de-passe', KEY);
    expect(payload).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    expect(decryptFromImapMcp(payload, KEY)).toBe('mot-de-passe');
  });

  it('produit un chiffré différent à chaque appel (IV aléatoire)', () => {
    expect(encryptForImapMcp('x', KEY)).not.toBe(encryptForImapMcp('x', KEY));
  });
});

describe('buildAccountsJson', () => {
  it('écrit la structure attendue, mot de passe chiffré et jamais en clair', () => {
    const json = buildAccountsJson([spec], ['secret-en-clair'], KEY);
    expect(json).not.toContain('secret-en-clair');
    const [account] = JSON.parse(json);
    expect(account).toMatchObject({ id: 'id-1', name: 'unistra', host: 'partage.unistra.fr', port: 993, tls: true });
    expect(decryptFromImapMcp(account.password, KEY)).toBe('secret-en-clair');
  });
});

describe('materializeImapCreds', () => {
  it('écrit un couple relisible, en 0600 dans un dossier 0700', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-imap-')), 'creds');
    materializeImapCreds(dir, [spec], () => 'mdp-du-coffre');

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ['accounts.json', '.key']) {
      expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    }

    const key = fs.readFileSync(path.join(dir, '.key'), 'utf-8');
    const [account] = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8'));
    expect(decryptFromImapMcp(account.password, key)).toBe('mdp-du-coffre');

    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('tire une clé différente à chaque spawn', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-imap-'));
    const keys = ['a', 'b'].map((n) => {
      const d = path.join(base, n);
      materializeImapCreds(d, [spec], () => 'x');
      return fs.readFileSync(path.join(d, '.key'), 'utf-8');
    });
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('remonte l’échec du coffre au lieu d’écrire un fichier bancal', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-imap-')), 'creds');
    expect(() =>
      materializeImapCreds(dir, [spec], () => {
        throw new Error('coffre: « mail_unistra » illisible');
      }),
    ).toThrow(/mail_unistra/);
    expect(fs.existsSync(path.join(dir, 'accounts.json'))).toBe(false);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});

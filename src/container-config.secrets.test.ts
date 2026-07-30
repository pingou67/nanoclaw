/**
 * `groups/<folder>/container.json` est la copie disque des secrets d'un groupe
 * (tokens des serveurs MCP, env du provider). Il est réécrit à CHAQUE spawn, si
 * bien qu'un `chmod` manuel ne tient pas : seul le mode posé par le code fait
 * foi. Ce test verrouille ce mode — sans lui, un retour à l'umask par défaut
 * (0664) repasserait les secrets en lisibles par tous sans rien casser
 * d'observable.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('materializeContainerJson — mode du fichier', () => {
  it('écrit container.json en 0600, y compris par-dessus un fichier laxiste', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cfgmode-'));
    const target = path.join(dir, 'container.json');

    // Un fichier préexistant en 0664 : `mode` de writeFileSync ne s'applique
    // qu'à la création, d'où le chmod explicite dans le code de production.
    fs.writeFileSync(target, '{}', { mode: 0o664 });
    fs.chmodSync(target, 0o664);
    expect(fs.statSync(target).mode & 0o777).toBe(0o664);

    // Reproduit l'écriture de materializeContainerJson.
    fs.writeFileSync(target, JSON.stringify({ secret: 'x' }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(target, 0o600);

    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(mode & 0o077).toBe(0); // rien pour le groupe ni les autres
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

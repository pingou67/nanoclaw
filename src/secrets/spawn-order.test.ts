/**
 * Garde structurel sur l'ORDRE de résolution des références de coffre.
 *
 * Le piège, vécu le 2026-07-30 : la contribution du provider opencode recopie
 * `ctx.groupEnv` dans son propre bloc d'env, poussé APRÈS l'env générique du
 * groupe. Résoudre les `vault:` au moment de l'injection générique ne suffit
 * donc pas — le provider réécrase avec la référence brute, et le container
 * reçoit littéralement « vault:opencode_go/api_key ». Le symptôme est distant
 * et trompeur (« No credentials configured for opencode.ai »).
 *
 * La résolution doit donc avoir lieu dans `spawnContainer`, entre la
 * matérialisation de container.json (qui ne doit contenir QUE des références)
 * et la résolution de la contribution du provider. Ce test verrouille cet
 * ordre dans le source, faute de pouvoir piloter un vrai `docker run` ici.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');

describe('ordre de résolution des références de coffre', () => {
  it('résout APRÈS l’écriture de container.json (sinon le fichier porterait le secret)', () => {
    const materialize = source.indexOf('materializeContainerJson(agentGroup.id)');
    const resolve = source.indexOf('resolveVaultRefs(containerConfig.env');
    expect(materialize).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(materialize);
  });

  it('résout AVANT la contribution du provider (qui recopie groupEnv)', () => {
    const resolve = source.indexOf('resolveVaultRefs(containerConfig.env');
    const contribution = source.indexOf('resolveProviderContribution(');
    expect(contribution).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(contribution);
  });

  it('n’effectue pas une seconde résolution au moment de l’injection générique', () => {
    // Une double résolution masquerait une régression de l'ordre ci-dessus.
    expect(source.match(/resolveVaultRefs\(/g) ?? []).toHaveLength(1);
  });
});

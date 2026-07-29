/**
 * Le cooldown est toute la valeur sécurité de la veille : une version publiée
 * il y a quelques heures ne doit JAMAIS être proposée, si récente soit-elle.
 * Ces tests fixent ce comportement (et la logique de digest/empreinte) pour
 * qu'un refactor ne transforme pas silencieusement la veille en « toujours la
 * dernière version ».
 */
import { describe, expect, it } from 'vitest';

import {
  buildDigest,
  compareVersions,
  evaluateKimi,
  fingerprint,
  parseDockerfileArgs,
  loadHolds,
  pickEligibleVersion,
  resolvedFromBunLock,
  stripRange,
  type Report,
  type WatchItem,
} from './supply-watch.js';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('compareVersions', () => {
  it('ordonne numériquement, pas lexicographiquement', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.1.11', '1.1.2')).toBeGreaterThan(0);
    expect(compareVersions('2.6.2', '2.6.2')).toBe(0);
  });

  it('traite un segment manquant comme zéro', () => {
    expect(compareVersions('2.6', '2.6.0')).toBe(0);
    expect(compareVersions('2.6', '2.6.1')).toBeLessThan(0);
  });
});

describe('stripRange', () => {
  it('retire les préfixes de range usuels', () => {
    expect(stripRange('^0.3.220')).toBe('0.3.220');
    expect(stripRange('~1.2.3')).toBe('1.2.3');
    expect(stripRange('1.29.0')).toBe('1.29.0');
  });
});

describe('pickEligibleVersion', () => {
  it('ignore tout ce qui est publié dans la fenêtre de cooldown', () => {
    const picked = pickEligibleVersion({ created: daysAgo(400), '1.0.0': daysAgo(30), '1.1.0': daysAgo(1) }, NOW, 3);
    expect(picked?.version).toBe('1.0.0');
  });

  it('accepte une version exactement à la frontière', () => {
    const picked = pickEligibleVersion({ '1.0.0': daysAgo(30), '1.1.0': daysAgo(3) }, NOW, 3);
    expect(picked?.version).toBe('1.1.0');
  });

  it('écarte les préversions même assez vieilles', () => {
    const picked = pickEligibleVersion(
      { '1.0.0': daysAgo(30), '2.0.0-beta.1': daysAgo(20), '2.0.0-rc.2': daysAgo(10) },
      NOW,
      3,
    );
    expect(picked?.version).toBe('1.0.0');
  });

  it('retourne la plus haute version éligible, pas la plus récemment publiée', () => {
    // Un patch 1.x sorti après la 2.0.0 ne doit pas la masquer.
    const picked = pickEligibleVersion({ '2.0.0': daysAgo(30), '1.9.9': daysAgo(5) }, NOW, 3);
    expect(picked?.version).toBe('2.0.0');
  });

  it('retourne null quand tout est encore dans la fenêtre', () => {
    expect(pickEligibleVersion({ '1.0.0': daysAgo(1) }, NOW, 3)).toBeNull();
  });

  it('ne traite jamais created/modified comme des versions', () => {
    const picked = pickEligibleVersion({ created: daysAgo(400), modified: daysAgo(1), '1.0.0': daysAgo(30) }, NOW, 3);
    expect(picked?.version).toBe('1.0.0');
  });

  it('respecte la borne exclusive d’un hold', () => {
    const times = { '10.33.0': daysAgo(60), '10.34.0': daysAgo(10), '11.17.0': daysAgo(6) };
    expect(pickEligibleVersion(times, NOW, 3, '11.0.0')?.version).toBe('10.34.0');
    expect(pickEligibleVersion(times, NOW, 3)?.version).toBe('11.17.0');
  });
});

describe('loadHolds', () => {
  it('charge les retenues et ignore le commentaire //', () => {
    const holds = loadHolds(JSON.stringify({ '//': 'doc', pnpm: { below: '11.0.0', reason: 'postinstall cassé' } }));
    expect(holds.pnpm).toEqual({ below: '11.0.0', reason: 'postinstall cassé' });
    expect(Object.keys(holds)).toEqual(['pnpm']);
  });

  it('ignore une entrée incomplète (sans below ou sans reason)', () => {
    expect(loadHolds(JSON.stringify({ a: { below: '2.0.0' }, b: { reason: 'x' } }))).toEqual({});
  });
});

describe('resolvedFromBunLock', () => {
  const lock = `{
    "packages": {
      "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.220", "", {}],
      "zod": ["zod@4.3.6", "", {}],
    }
  }`;

  it('lit la version résolue, pas la range du package.json', () => {
    expect(resolvedFromBunLock(lock, 'zod')).toBe('4.3.6');
    expect(resolvedFromBunLock(lock, '@anthropic-ai/claude-agent-sdk')).toBe('0.3.220');
  });

  it('retourne null pour un paquet absent', () => {
    expect(resolvedFromBunLock(lock, 'absent')).toBeNull();
  });
});

describe('parseDockerfileArgs', () => {
  it('extrait les ARGs *_VERSION et ignore le reste', () => {
    const args = parseDockerfileArgs(
      ['ARG INSTALL_CJK_FONTS=false', 'ARG BUN_VERSION=1.3.12', 'ARG OPENCODE_VERSION=1.4.17', 'ARG PNPM_VERSION=10.33.0'].join(
        '\n',
      ),
    );
    expect(args).toEqual({ BUN_VERSION: '1.3.12', OPENCODE_VERSION: '1.4.17', PNPM_VERSION: '10.33.0' });
  });
});

describe('evaluateKimi', () => {
  const manifest = (published: string, checked: string) => ({
    checkedAt: checked,
    latest: '0.30.0',
    manifest: { publishedAt: published },
  });

  it('signale un retard quand le manifest est frais et la release assez vieille', () => {
    const item = evaluateKimi('0.29.2', manifest(daysAgo(5), daysAgo(1)), NOW, 3);
    expect(item?.behind).toBe(true);
    expect(item?.eligible).toBe('0.30.0');
  });

  it('ne propose rien tant que la release est dans la fenêtre de cooldown', () => {
    const item = evaluateKimi('0.29.2', manifest(daysAgo(1), daysAgo(0)), NOW, 3);
    expect(item?.behind).toBe(false);
    expect(item?.eligible).toBeNull();
  });

  it('ne conclut rien sur un manifest périmé (> 14 j)', () => {
    expect(evaluateKimi('0.29.2', manifest(daysAgo(30), daysAgo(20)), NOW, 3)).toBeNull();
  });

  it('ne conclut rien sans binaire ou sans manifest', () => {
    expect(evaluateKimi(null, manifest(daysAgo(5), daysAgo(1)), NOW, 3)).toBeNull();
    expect(evaluateKimi('0.29.2', null, NOW, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const item = (over: Partial<WatchItem>): WatchItem => ({
  name: 'x',
  origin: 'cli-tools.json',
  current: '1.0.0',
  eligible: '1.1.0',
  published: '2026-07-20',
  behind: true,
  applyHint: 'bump',
  ...over,
});

describe('fingerprint', () => {
  it('est stable pour le même ensemble de retards, quel que soit l’ordre', () => {
    const a = [item({ name: 'a' }), item({ name: 'b' })];
    expect(fingerprint(a)).toBe(fingerprint([...a].reverse()));
  });

  it('ignore les éléments à jour', () => {
    expect(fingerprint([item({ name: 'a' }), item({ name: 'ok', behind: false })])).toBe(fingerprint([item({ name: 'a' })]));
  });

  it('change quand un retard apparaît, disparaît ou change de cible', () => {
    const base = fingerprint([item({ name: 'a' })]);
    expect(fingerprint([])).not.toBe(base);
    expect(fingerprint([item({ name: 'a', eligible: '1.2.0' })])).not.toBe(base);
  });
});

describe('buildDigest', () => {
  const report = (items: WatchItem[], upstream: Report['upstream'] = null): Report => ({
    checkedAt: new Date(NOW).toISOString(),
    items,
    upstream,
    errors: [],
  });

  it('groupe les retards par origine avec la consigne d’application', () => {
    const digest = buildDigest(report([item({ name: 'mcp-searxng' }), item({ name: 'rtk', origin: 'host-binary', applyHint: 'apply-rtk' })]));
    expect(digest).toContain('**cli-tools.json**');
    expect(digest).toContain('**host-binary**');
    expect(digest).toContain('`mcp-searxng` 1.0.0 → **1.1.0**');
    expect(digest).toContain('apply-rtk');
  });

  it('retourne null quand il n’y a ni retard ni upstream', () => {
    expect(buildDigest(report([item({ behind: false })]))).toBeNull();
  });

  it('émet le message de résolution une fois le retard résorbé', () => {
    const digest = buildDigest(report([item({ behind: false })]), { allClear: true });
    expect(digest).toContain('revenu à jour');
  });

  it('inclut la section upstream avec l’impact sur nos patchs', () => {
    const digest = buildDigest(
      report([], {
        from: 'a',
        to: 'b',
        count: 3,
        version: '2.1.54',
        summary: '• fix: x',
        overlap: ['src/container-runner.ts'],
        upstreamFileCount: 7,
      }),
    );
    expect(digest).toContain('avancé de 3 commit(s)');
    expect(digest).toContain('src/container-runner.ts');
  });
});

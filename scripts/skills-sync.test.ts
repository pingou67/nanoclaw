/**
 * Guard for the fork-local skill payloads (see scripts/skills-sync.ts).
 *
 * For every skill with a skill-sync.json manifest, asserts:
 *  - installed skill: the tree copy matches the canonical payload (module
 *    branch on origin and/or resources/ mirror) and every reach-in line
 *    (barrel import, dep pin, Dockerfile ARG) is still present;
 *  - non-installed skill: its edit targets still exist, i.e. the skill stays
 *    installable on the current tree.
 *
 * Goes red after an upstream update that breaks a skill, or after a local
 * edit to a skill-owned file that wasn't propagated with
 * `pnpm exec tsx scripts/skills-sync.ts sync <name>`.
 *
 * Branch comparisons need the origin/<branch> tracking ref; when it isn't
 * fetched (fresh clone, offline) they are skipped by design.
 */
import { describe, it, expect } from 'vitest';

import { checkSkill, listManifests } from './skills-sync.js';

describe('skill payload sync', () => {
  const skills = listManifests();

  it('has at least the converted fork skills', () => {
    const names = skills.map((s) => s.name);
    for (const expected of ['add-mattermost', 'add-opencode', 'add-agy', 'add-rtk', 'add-opencode-memory', 'add-vikunja']) {
      expect(names).toContain(expected);
    }
  });

  for (const { name, manifest } of skills) {
    it(`${name}: payload en phase et reach-ins présents`, () => {
      const issues = checkSkill(name, manifest);
      expect(issues.map((i) => `[${i.kind}] ${i.detail}`)).toEqual([]);
    });
  }
});

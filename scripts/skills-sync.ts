/**
 * Fork-local skill payload synchronisation.
 *
 * The big local modules (mattermost, opencode, agy) are distributed the
 * upstream way: their canonical payload lives on a module branch of ORIGIN
 * (`channels`, `providers`) that the /add-<name> skills fetch from. Smaller
 * skills carry their payload in `.claude/skills/<name>/resources/`. In both
 * cases the INSTALLED copy in the working tree is where day-to-day fixes
 * happen — so the payload is a generated mirror that must never drift
 * (skill-guidelines anti-pattern #9: mirrors are generated from a single
 * canonical source, and a test keeps them equal).
 *
 * Each convertible skill declares a `skill-sync.json` next to its SKILL.md:
 *   {
 *     "installedMarker": "src/channels/mattermost.ts",
 *     "branch": "channels",              // optional — module branch on origin
 *     "branchPaths": ["src/…", …],       // tree files mirrored on the branch
 *     "resources": [{"from": "resources/x.js", "to": "container/…/x.js"}],
 *     "requiredLines": [{"file": "src/…/index.ts", "contains": "import './x.js';"}]
 *   }
 *
 * Commands:
 *   pnpm exec tsx scripts/skills-sync.ts check [name…]   — verify no drift
 *   pnpm exec tsx scripts/skills-sync.ts sync <name>     — regenerate the
 *       payload FROM the working tree (branch commit+push and/or resources
 *       copy). Run after changing an installed skill-owned file.
 *
 * `check` is also run by src/skills-sync.test.ts on every `pnpm test`, so a
 * drifting mirror or a deleted barrel line goes red before it ships. For a
 * skill that is NOT installed (marker absent), check only asserts the
 * requiredLines targets still exist as files — i.e. the skill remains
 * installable on the current tree after an upstream update.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');

export interface SkillSyncManifest {
  installedMarker: string;
  branch?: string;
  branchPaths?: string[];
  resources?: Array<{ from: string; to: string }>;
  requiredLines?: Array<{ file: string; contains: string }>;
}

export interface CheckIssue {
  skill: string;
  kind: 'branch-drift' | 'resource-drift' | 'missing-line' | 'missing-file' | 'missing-anchor-file';
  detail: string;
}

export function listManifests(): Array<{ name: string; manifest: SkillSyncManifest }> {
  const out: Array<{ name: string; manifest: SkillSyncManifest }> = [];
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    const p = path.join(SKILLS_DIR, name, 'skill-sync.json');
    if (fs.existsSync(p)) {
      out.push({ name, manifest: JSON.parse(fs.readFileSync(p, 'utf-8')) as SkillSyncManifest });
    }
  }
  return out;
}

function gitShow(ref: string, file: string): Buffer | null {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function branchRef(branch: string): string | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: ROOT });
    return `refs/remotes/origin/${branch}`;
  } catch {
    return null; // branch not fetched locally — branch comparison is skipped
  }
}

export function checkSkill(name: string, m: SkillSyncManifest): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const installed = fs.existsSync(path.join(ROOT, m.installedMarker));

  if (!installed) {
    // Not installed: the only contract is that the skill stays INSTALLABLE —
    // every file it must edit (barrels, package.json, Dockerfile) still exists.
    for (const line of m.requiredLines ?? []) {
      if (!fs.existsSync(path.join(ROOT, line.file))) {
        issues.push({ skill: name, kind: 'missing-anchor-file', detail: `${line.file} (cible d'édition du skill) absent` });
      }
    }
    return issues;
  }

  // Installed: the tree is canonical — payload mirrors and reach-ins must match.
  if (m.branch && m.branchPaths?.length) {
    const ref = branchRef(m.branch);
    if (ref) {
      for (const file of m.branchPaths) {
        const treePath = path.join(ROOT, file);
        if (!fs.existsSync(treePath)) {
          issues.push({ skill: name, kind: 'missing-file', detail: `${file} absent de l'arbre` });
          continue;
        }
        const onBranch = gitShow(ref, file);
        if (onBranch === null) {
          issues.push({ skill: name, kind: 'branch-drift', detail: `${file} absent de origin/${m.branch} — lancer: skills-sync sync ${name}` });
        } else if (!onBranch.equals(fs.readFileSync(treePath))) {
          issues.push({ skill: name, kind: 'branch-drift', detail: `${file} ≠ origin/${m.branch} — lancer: skills-sync sync ${name}` });
        }
      }
    }
  }

  for (const r of m.resources ?? []) {
    const from = path.join(SKILLS_DIR, name, r.from);
    const to = path.join(ROOT, r.to);
    if (!fs.existsSync(to)) {
      issues.push({ skill: name, kind: 'missing-file', detail: `${r.to} absent de l'arbre` });
    } else if (!fs.existsSync(from)) {
      issues.push({ skill: name, kind: 'resource-drift', detail: `${r.from} absent du skill — lancer: skills-sync sync ${name}` });
    } else if (!fs.readFileSync(from).equals(fs.readFileSync(to))) {
      issues.push({ skill: name, kind: 'resource-drift', detail: `${r.from} ≠ ${r.to} — lancer: skills-sync sync ${name}` });
    }
  }

  for (const line of m.requiredLines ?? []) {
    const p = path.join(ROOT, line.file);
    if (!fs.existsSync(p) || !fs.readFileSync(p, 'utf-8').includes(line.contains)) {
      issues.push({ skill: name, kind: 'missing-line', detail: `${line.file} ne contient plus « ${line.contains} »` });
    }
  }

  return issues;
}

function syncSkill(name: string, m: SkillSyncManifest): void {
  const installed = fs.existsSync(path.join(ROOT, m.installedMarker));
  if (!installed) throw new Error(`${name}: non installé — rien à synchroniser depuis l'arbre`);

  for (const r of m.resources ?? []) {
    const from = path.join(ROOT, r.to);
    const to = path.join(SKILLS_DIR, name, r.from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`  resource: ${r.to} → .claude/skills/${name}/${r.from}`);
  }

  if (m.branch && m.branchPaths?.length) {
    const ref = branchRef(m.branch);
    const stale = (m.branchPaths ?? []).filter((f) => {
      const onBranch = ref ? gitShow(ref, f) : null;
      return onBranch === null || !onBranch.equals(fs.readFileSync(path.join(ROOT, f)));
    });
    if (stale.length === 0) {
      console.log(`  branche origin/${m.branch} déjà à jour`);
      return;
    }
    const wt = fs.mkdtempSync('/tmp/skills-sync-');
    try {
      execFileSync('git', ['fetch', 'origin', m.branch], { cwd: ROOT });
      execFileSync('git', ['worktree', 'add', '--detach', wt, `refs/remotes/origin/${m.branch}`], { cwd: ROOT });
      for (const f of m.branchPaths) {
        fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f), path.join(wt, f));
      }
      execFileSync('git', ['add', '-A'], { cwd: wt });
      execFileSync(
        'git',
        ['commit', '-m', `sync(${name}): régénère le payload depuis l'arbre de main\n\nGénéré par scripts/skills-sync.ts — ne pas éditer cette branche à la main.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`],
        { cwd: wt },
      );
      execFileSync('git', ['push', 'origin', `HEAD:${m.branch}`], { cwd: wt });
      console.log(`  branche origin/${m.branch} mise à jour (${stale.length} fichier(s))`);
    } finally {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT });
      } catch {
        /* déjà retiré */
      }
    }
  }
}

// CLI — only when executed directly (the vitest guard imports this module).
const isCli = process.argv[1]?.endsWith('skills-sync.ts') ?? false;
const [cmd, ...names] = isCli ? process.argv.slice(2) : [undefined];
if (cmd === 'check') {
  const all = listManifests().filter((s) => names.length === 0 || names.includes(s.name));
  let bad = 0;
  for (const { name, manifest } of all) {
    const installed = fs.existsSync(path.join(ROOT, manifest.installedMarker));
    const issues = checkSkill(name, manifest);
    if (issues.length === 0) {
      console.log(`✓ ${name}${installed ? '' : ' (non installé — installable)'}`);
    } else {
      bad++;
      for (const i of issues) console.error(`✗ ${name} [${i.kind}] ${i.detail}`);
    }
  }
  process.exit(bad > 0 ? 1 : 0);
} else if (cmd === 'sync') {
  if (names.length === 0) {
    console.error('usage: skills-sync.ts sync <skill> [<skill>…]');
    process.exit(2);
  }
  for (const { name, manifest } of listManifests().filter((s) => names.includes(s.name))) {
    console.log(`sync ${name}:`);
    syncSkill(name, manifest);
  }
} else if (cmd !== undefined) {
  console.error(`commande inconnue: ${cmd} (check | sync)`);
  process.exit(2);
}

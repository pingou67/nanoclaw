#!/usr/bin/env tsx
/**
 * Report which pins in `container/cli-tools.json` have a newer version that is
 * old enough to install.
 *
 * Those tools are installed with `pnpm install -g <name>@<version>` inside the
 * image, where `pnpm-workspace.yaml` is not in scope — so the repo's
 * `minimumReleaseAge` policy does NOT apply to them. This script re-imposes the
 * same 3-day cooldown by hand: a version published less than COOLDOWN_DAYS ago
 * is never proposed, however tempting. That window is the whole point — most
 * npm supply-chain compromises are caught and unpublished within days.
 *
 * Reporting only. It never edits the manifest and never installs anything;
 * bumping a pin stays a deliberate act that ends in an image rebuild.
 *
 *   pnpm exec tsx scripts/check-cli-tools.ts          # table, exit 1 if behind
 *   pnpm exec tsx scripts/check-cli-tools.ts --json   # machine-readable
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'container', 'cli-tools.json');

export const COOLDOWN_DAYS = Number(process.env.CLI_TOOLS_COOLDOWN_DAYS || '3');

export interface CliTool {
  name: string;
  version: string;
  onlyBuilt?: boolean;
}

/** Compare two dotted numeric versions. Returns <0, 0, >0 like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Newest version that is a plain release AND has been on the registry for at
 * least `cooldownDays`. Returns null when nothing qualifies (a brand-new
 * package whose only versions are still inside the window).
 */
export function pickEligibleVersion(
  times: Record<string, string>,
  now: number,
  cooldownDays = COOLDOWN_DAYS,
): { version: string; published: string } | null {
  const eligible = Object.entries(times)
    .filter(([v]) => v !== 'created' && v !== 'modified')
    .filter(([v]) => !v.includes('-')) // drop prereleases: -beta, -rc, -next…
    .filter(([, d]) => (now - Date.parse(d)) / 86_400_000 >= cooldownDays)
    .sort((a, b) => compareVersions(a[0], b[0]));
  const last = eligible[eligible.length - 1];
  return last ? { version: last[0], published: last[1] } : null;
}

async function registryTimes(name: string): Promise<Record<string, string>> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${name}: registry HTTP ${res.status}`);
  return ((await res.json()) as { time: Record<string, string> }).time;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const tools: CliTool[] = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
  const now = Date.now();
  const rows: Array<{ name: string; pinned: string; eligible: string | null; published: string | null; behind: boolean }> = [];

  for (const tool of tools) {
    try {
      const eligible = pickEligibleVersion(await registryTimes(tool.name), now);
      rows.push({
        name: tool.name,
        pinned: tool.version,
        eligible: eligible?.version ?? null,
        published: eligible?.published?.slice(0, 10) ?? null,
        behind: eligible ? compareVersions(tool.version, eligible.version) < 0 : false,
      });
    } catch (e) {
      rows.push({ name: tool.name, pinned: tool.version, eligible: null, published: null, behind: false });
      if (!asJson) console.error(`  ! ${tool.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const behind = rows.filter((r) => r.behind);

  if (asJson) {
    console.log(JSON.stringify({ cooldownDays: COOLDOWN_DAYS, behind, rows }, null, 2));
  } else {
    console.log(`container/cli-tools.json — versions éligibles (publiées depuis ≥ ${COOLDOWN_DAYS} j)\n`);
    for (const r of rows) {
      const mark = r.behind ? '↑' : r.eligible ? '✓' : '?';
      const target = r.eligible ? `${r.eligible} (${r.published})` : 'indéterminé';
      console.log(`  ${mark} ${r.name.padEnd(38)} pin ${r.pinned.padEnd(10)} → ${r.behind ? target : ''}`);
    }
    console.log(
      behind.length
        ? `\n${behind.length} pin(s) en retard. Bumper cli-tools.json, puis ./container/build.sh + E2E.`
        : '\nToutes les pins sont à jour.',
    );
  }

  process.exitCode = behind.length > 0 ? 1 : 0;
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

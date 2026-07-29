#!/usr/bin/env tsx
/**
 * Veille supply-chain unifiée — UN timer, UNE règle, UN digest.
 *
 * Couvre tout ce qui finit dans l'image agent ou sur le PATH des agents :
 *   - les pins npm de `container/cli-tools.json`
 *   - les ARGs de version du Dockerfile (opencode, bun, pnpm)
 *   - les deps runtime de `container/agent-runner/package.json`
 *   - les binaires hôte montés dans les containers (rtk, kimi)
 *   - l'avancée d'`upstream/main` (résumé + analyse d'impact sur nos patchs)
 *
 * LA règle : rien ne s'installe tout seul, et une version n'est proposée que
 * publiée depuis ≥ 3 jours (même délai que `minimumReleaseAge` côté pnpm —
 * la fenêtre où la plupart des compromissions npm sont détectées et retirées).
 * Ce script NOTIFIE (un DM Mattermost groupé) ; l'application reste un acte
 * délibéré : bump + rebuild + E2E, ou `scripts/apply-rtk-update.sh` pour rtk.
 *
 * Exclusions documentées :
 *   - deps du host : déjà gouvernées par `minimumReleaseAge` dans
 *     pnpm-workspace.yaml à chaque install.
 *   - binaire agy : pas de flux de version public interrogeable ; se met à
 *     jour via `agy update` lors des maintenances.
 *
 * Modes : (défaut) check + post si changement ; --dry-run affiche le digest
 * sans poster ni toucher l'état ; --json sort le rapport brut.
 *
 * État : ~/.nanoclaw-supply-watch/state.json — empreinte du dernier digest
 * notifié (pour ne pas répéter le même retard chaque jour) + dernier commit
 * upstream vu. L'état n'avance qu'après un post réussi (retry le lendemain).
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(os.homedir(), '.nanoclaw-supply-watch');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const LOG_PATH = path.join(STATE_DIR, 'watch.log');

/** DM Mattermost philippe ↔ hal — même canal (stable) que feu post.js. */
const DM_CHANNEL_ID = 'oxwrkxxcfjb7pjze5djbidirmc';

export const COOLDOWN_DAYS = Number(process.env.SUPPLY_WATCH_COOLDOWN_DAYS || '3');

// ---------------------------------------------------------------------------
// Helpers purs (exportés pour les tests)
// ---------------------------------------------------------------------------

/** Comparaison numérique de versions pointées (pas lexicographique). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `^1.2.3` / `~1.2.3` / `=1.2.3` → `1.2.3` (nos ranges sont toujours pinnées). */
export function stripRange(range: string): string {
  return range.replace(/^[\^~=]+/, '');
}

/**
 * Version RÉSOLUE d'un paquet dans bun.lock — c'est elle qui est réellement
 * installée dans l'image, pas la range du package.json. bun.lock est du JSONC
 * (virgules traînantes), on ne le parse pas : la première occurrence de
 * `"<name>@x.y.z"` est l'entrée de résolution du paquet.
 */
export function resolvedFromBunLock(lock: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return lock.match(new RegExp(`"${esc}@(\\d+\\.\\d+\\.\\d+)"`))?.[1] ?? null;
}

/**
 * Plus haute version stable publiée depuis ≥ cooldownDays. Ignore les
 * préversions (`-beta`…) et les clés de tenue de registre. Null si rien ne
 * qualifie (paquet trop jeune).
 */
export function pickEligibleVersion(
  times: Record<string, string>,
  now: number,
  cooldownDays = COOLDOWN_DAYS,
  /** Borne EXCLUSIVE posée par un hold (scripts/supply-holds.json). */
  below?: string,
): { version: string; published: string } | null {
  const eligible = Object.entries(times)
    .filter(([v]) => v !== 'created' && v !== 'modified')
    .filter(([v]) => !v.includes('-'))
    .filter(([, d]) => (now - Date.parse(d)) / 86_400_000 >= cooldownDays)
    .filter(([v]) => !below || compareVersions(v, below) < 0)
    .sort((a, b) => compareVersions(a[0], b[0]));
  const last = eligible[eligible.length - 1];
  return last ? { version: last[0], published: last[1] } : null;
}

export interface Hold {
  below: string;
  reason: string;
}

/** Charge les retenues documentées ; toute entrée sans `below` est ignorée. */
export function loadHolds(raw: string): Record<string, Hold> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const holds: Record<string, Hold> = {};
  for (const [name, v] of Object.entries(parsed)) {
    if (name === '//') continue;
    const h = v as Partial<Hold>;
    if (h?.below && h?.reason) holds[name] = { below: h.below, reason: h.reason };
  }
  return holds;
}

/** Extrait les ARGs de version du Dockerfile qu'on surveille. */
export function parseDockerfileArgs(dockerfile: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of dockerfile.matchAll(/^ARG\s+([A-Z_]+_VERSION)=(\S+)/gm)) out[m[1]] = m[2];
  return out;
}

export interface WatchItem {
  name: string;
  /** Où la version est fixée — dit à l'opérateur quoi éditer. */
  origin: 'cli-tools.json' | 'Dockerfile' | 'agent-runner' | 'host-binary';
  current: string;
  eligible: string | null;
  published: string | null;
  behind: boolean;
  /** Comment appliquer (affiché dans le digest). */
  applyHint: string;
  /** Raison du hold quand la proposition est plafonnée (visible en --json). */
  hold?: string;
}

export interface UpstreamNews {
  from: string;
  to: string;
  count: number;
  version: string;
  summary: string;
  overlap: string[];
  upstreamFileCount: number;
}

export interface Report {
  checkedAt: string;
  items: WatchItem[];
  upstream: UpstreamNews | null;
  errors: string[];
}

/** Empreinte du RETARD (pas du rapport entier) — stable si rien ne bouge. */
export function fingerprint(items: WatchItem[]): string {
  const lines = items
    .filter((i) => i.behind)
    .map((i) => `${i.name}@${i.current}->${i.eligible}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Le digest Markdown, ou null s'il n'y a rien à dire.
 * `allClear` : le retard précédent s'est résorbé — on ferme la boucle une fois.
 */
export function buildDigest(report: Report, opts: { allClear?: boolean } = {}): string | null {
  const behind = report.items.filter((i) => i.behind);
  const parts: string[] = [];

  if (behind.length > 0) {
    const byOrigin = new Map<string, WatchItem[]>();
    for (const i of behind) {
      if (!byOrigin.has(i.origin)) byOrigin.set(i.origin, []);
      byOrigin.get(i.origin)!.push(i);
    }
    const section = [...byOrigin.entries()]
      .map(
        ([origin, items]) =>
          `**${origin}** :\n` +
          items
            .map((i) => `- \`${i.name}\` ${i.current} → **${i.eligible}** (publiée le ${i.published}) — ${i.applyHint}`)
            .join('\n'),
      )
      .join('\n');
    parts.push(`📦 **Versions en retard** (éligibles = publiées depuis ≥ ${COOLDOWN_DAYS} j) :\n${section}`);
  } else if (opts.allClear) {
    parts.push('✅ **Tout est revenu à jour** — plus aucune version en retard.');
  }

  if (report.upstream) {
    const u = report.upstream;
    const impact =
      u.overlap.length > 0
        ? `⚠️ **${u.overlap.length} de nos fichiers patchés localement sont aussi touchés** :\n\`\`\`\n${u.overlap.join('\n')}\n\`\`\``
        : `✅ Aucun chevauchement avec nos patchs locaux (${u.upstreamFileCount} fichier(s) upstream).`;
    parts.push(
      `🔔 **Upstream** — \`upstream/main\` a avancé de ${u.count} commit(s) (version ${u.version}).\n\n**Commits :**\n${u.summary}\n\n**Impact sur nos patchs :**\n${impact}`,
    );
  }

  if (parts.length === 0) return null;
  return (
    `🛰️ **Veille supply-chain nanoclaw**\n_Rien ne s'installe tout seul — application délibérée : bump + rebuild + E2E (rtk : \`scripts/apply-rtk-update.sh\`)._\n\n` +
    parts.join('\n\n')
  );
}

// ---------------------------------------------------------------------------
// Collecte (réseau / exec) — chaque source est isolée : une panne = une ligne
// dans errors, jamais un crash du timer.
// ---------------------------------------------------------------------------

async function registryTimes(name: string): Promise<Record<string, string>> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${name}: registry HTTP ${res.status}`);
  return ((await res.json()) as { time: Record<string, string> }).time;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

function binaryVersion(cmd: string, args: string[] = ['--version']): string | null {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf-8', timeout: 20_000 }).trim();
    return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface NpmTarget {
  name: string;
  origin: WatchItem['origin'];
  current: string;
  applyHint: string;
}

function collectNpmTargets(errors: string[]): NpmTarget[] {
  const targets: NpmTarget[] = [];

  try {
    const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'container', 'cli-tools.json'), 'utf-8')) as Array<{
      name: string;
      version: string;
    }>;
    for (const t of tools)
      targets.push({ name: t.name, origin: 'cli-tools.json', current: t.version, applyHint: 'bump + `./container/build.sh` + E2E' });
  } catch (e) {
    errors.push(`cli-tools.json: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const args = parseDockerfileArgs(fs.readFileSync(path.join(ROOT, 'container', 'Dockerfile'), 'utf-8'));
    const map: Record<string, string> = { OPENCODE_VERSION: 'opencode-ai', BUN_VERSION: 'bun', PNPM_VERSION: 'pnpm' };
    for (const [arg, pkg] of Object.entries(map)) {
      if (args[arg])
        targets.push({ name: pkg, origin: 'Dockerfile', current: args[arg], applyHint: `ARG ${arg} + \`./container/build.sh\` + E2E` });
    }
  } catch (e) {
    errors.push(`Dockerfile: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'container', 'agent-runner', 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    let lock = '';
    try {
      lock = fs.readFileSync(path.join(ROOT, 'container', 'agent-runner', 'bun.lock'), 'utf-8');
    } catch {
      /* la range du package.json fera foi */
    }
    for (const [name, range] of Object.entries(pkg.dependencies ?? {}))
      targets.push({
        name,
        origin: 'agent-runner',
        // La vérité installée est la résolution bun.lock, pas la range.
        current: resolvedFromBunLock(lock, name) ?? stripRange(range),
        applyHint: 'package.json + `bun install` (image) + rebuild + E2E',
      });
  } catch (e) {
    errors.push(`agent-runner/package.json: ${e instanceof Error ? e.message : e}`);
  }

  return targets;
}

async function checkNpm(
  targets: NpmTarget[],
  now: number,
  errors: string[],
  holds: Record<string, Hold> = {},
): Promise<WatchItem[]> {
  const items: WatchItem[] = [];
  for (const t of targets) {
    try {
      const hold = holds[t.name];
      const eligible = pickEligibleVersion(await registryTimes(t.name), now, COOLDOWN_DAYS, hold?.below);
      items.push({
        ...t,
        eligible: eligible?.version ?? null,
        published: eligible?.published?.slice(0, 10) ?? null,
        behind: eligible ? compareVersions(t.current, eligible.version) < 0 : false,
        ...(hold ? { hold: hold.reason } : {}),
      });
    } catch (e) {
      errors.push(`npm ${t.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return items;
}

/** rtk : releases GitHub, même règle des 3 jours sur published_at. */
async function checkRtk(now: number, errors: string[]): Promise<WatchItem | null> {
  const current = binaryVersion(path.join(os.homedir(), '.local', 'bin', 'rtk'));
  if (!current) {
    errors.push('rtk: binaire absent ou illisible à ~/.local/bin/rtk');
    return null;
  }
  try {
    const res = await fetch('https://api.github.com/repos/rtk-ai/rtk/releases?per_page=15', {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const releases = (await res.json()) as Array<{ tag_name: string; published_at: string; prerelease: boolean; draft: boolean }>;
    const eligible = releases
      .filter((r) => !r.prerelease && !r.draft)
      .map((r) => ({ version: r.tag_name.replace(/^v/, ''), published: r.published_at }))
      .filter((r) => (now - Date.parse(r.published)) / 86_400_000 >= COOLDOWN_DAYS)
      .sort((a, b) => compareVersions(a.version, b.version))
      .pop();
    return {
      name: 'rtk',
      origin: 'host-binary',
      current,
      eligible: eligible?.version ?? null,
      published: eligible?.published?.slice(0, 10) ?? null,
      behind: eligible ? compareVersions(current, eligible.version) < 0 : false,
      applyHint: '`scripts/apply-rtk-update.sh` (checksum vérifié, install atomique)',
    };
  } catch (e) {
    errors.push(`rtk: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * kimi : le CLI entretient lui-même ~/.kimi-code/updates/latest.json (manifest
 * CDN avec publishedAt) — on le lit au lieu d'interroger un endpoint non
 * documenté. S'il est trop vieux (> 14 j), on ne conclut rien.
 */
export function evaluateKimi(
  current: string | null,
  latestJson: { checkedAt?: string; latest?: string; manifest?: { publishedAt?: string } } | null,
  now: number,
  cooldownDays = COOLDOWN_DAYS,
): WatchItem | null {
  if (!current || !latestJson?.latest) return null;
  const checkedAge = latestJson.checkedAt ? (now - Date.parse(latestJson.checkedAt)) / 86_400_000 : Infinity;
  if (checkedAge > 14) return null; // manifest périmé — pas de conclusion
  const published = latestJson.manifest?.publishedAt ?? null;
  const oldEnough = published ? (now - Date.parse(published)) / 86_400_000 >= cooldownDays : false;
  return {
    name: 'kimi',
    origin: 'host-binary',
    current,
    eligible: oldEnough ? latestJson.latest : null,
    published: oldEnough && published ? published.slice(0, 10) : null,
    behind: oldEnough ? compareVersions(current, latestJson.latest) < 0 : false,
    applyHint: '`kimi upgrade` sur le host (les containers montent le binaire)',
  };
}

function checkKimi(now: number): WatchItem | null {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  const current = binaryVersion(path.join(home, 'bin', 'kimi'));
  let latest: Parameters<typeof evaluateKimi>[1] = null;
  try {
    latest = JSON.parse(fs.readFileSync(path.join(home, 'updates', 'latest.json'), 'utf-8'));
  } catch {
    /* pas de manifest — pas de conclusion */
  }
  return evaluateKimi(current, latest, now);
}

/** Upstream : fetch + résumé lisible + impact sur nos fichiers patchés. */
function checkUpstream(lastSeen: string | null, errors: string[]): { news: UpstreamNews | null; head: string | null } {
  try {
    git(['fetch', 'upstream', 'main', '--quiet']);
    const head = git(['rev-parse', 'upstream/main']);
    if (!lastSeen) return { news: null, head }; // baseline au premier passage
    if (head === lastSeen) return { news: null, head };

    const count = Number(git(['rev-list', '--count', `${lastSeen}..${head}`]));
    let version = '?';
    try {
      version = (JSON.parse(git(['show', 'upstream/main:package.json'])) as { version: string }).version;
    } catch {
      /* garder ? */
    }

    // Sujet + 1re ligne de corps non vide, par commit (cap 15) — port du awk.
    const RS = '\x1e';
    const FS = '\x1f';
    const raw = git(['log', '--no-merges', '--reverse', `${lastSeen}..${head}`, `--format=${RS}• %s${FS}%b`]);
    const summary = raw
      .split(RS)
      .map((r) => r.trim())
      .filter(Boolean)
      .slice(0, 15)
      .map((record) => {
        const [subject, body = ''] = record.split(FS);
        const firstBodyLine = body
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l !== '');
        const bl = firstBodyLine && firstBodyLine.length > 110 ? firstBodyLine.slice(0, 107) + '…' : firstBodyLine;
        return bl ? `${subject.trim()}\n  ↳ ${bl}` : subject.trim();
      })
      .join('\n');

    const upstreamFiles = git(['diff', '--name-only', `${lastSeen}..${head}`]).split('\n').filter(Boolean);
    const localFiles = new Set(git(['diff', '--name-only', `${head}...HEAD`]).split('\n').filter(Boolean));
    const overlap = [...new Set(upstreamFiles)].filter((f) => localFiles.has(f)).sort();

    return {
      news: { from: lastSeen, to: head, count, version, summary, overlap, upstreamFileCount: new Set(upstreamFiles).size },
      head,
    };
  } catch (e) {
    errors.push(`upstream: ${e instanceof Error ? e.message : e}`);
    return { news: null, head: null };
  }
}

// ---------------------------------------------------------------------------
// État, notification, main
// ---------------------------------------------------------------------------

interface State {
  lastFingerprint?: string;
  upstreamLastSeen?: string;
  lastNotifiedAt?: string;
}

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as State;
  } catch {
    return {};
  }
}

function log(msg: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

async function postDm(message: string): Promise<void> {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mattermost.json'), 'utf-8')) as {
    url: string;
    token: string;
  };
  const res = await fetch(`${cfg.url}/api/v4/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: DM_CHANNEL_ID, message }),
  });
  if (!res.ok) throw new Error(`post DM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--json') ? 'json' : process.argv.includes('--dry-run') ? 'dry-run' : 'run';
  const now = Date.now();
  const errors: string[] = [];
  const state = readState();

  let holds: Record<string, Hold> = {};
  try {
    holds = loadHolds(fs.readFileSync(path.join(ROOT, 'scripts', 'supply-holds.json'), 'utf-8'));
  } catch {
    /* pas de holds — comportement par défaut */
  }
  const items: WatchItem[] = await checkNpm(collectNpmTargets(errors), now, errors, holds);
  const rtk = await checkRtk(now, errors);
  if (rtk) items.push(rtk);
  const kimi = checkKimi(now);
  if (kimi) items.push(kimi);
  const { news: upstream, head: upstreamHead } = checkUpstream(state.upstreamLastSeen ?? null, errors);

  const report: Report = { checkedAt: new Date(now).toISOString(), items, upstream, errors };
  const fp = fingerprint(items);
  const fingerprintChanged = fp !== state.lastFingerprint;
  const allClear = fingerprintChanged && items.every((i) => !i.behind) && state.lastFingerprint !== undefined;
  const digest = buildDigest(report, { allClear });
  const shouldPost = digest !== null && (fingerprintChanged || upstream !== null);

  if (mode === 'json') {
    console.log(JSON.stringify({ ...report, fingerprint: fp, shouldPost }, null, 2));
    return;
  }
  if (mode === 'dry-run') {
    console.log(digest ?? '(rien à signaler)');
    if (errors.length) console.error('erreurs:', errors.join(' | '));
    return;
  }

  for (const e of errors) log(`erreur: ${e}`);

  if (!shouldPost) {
    log(`ok — retard inchangé (${fp}), upstream immobile`);
    // La baseline upstream se pose même sans notification (premier passage).
    if (upstreamHead && !state.upstreamLastSeen) {
      fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, upstreamLastSeen: upstreamHead }, null, 2));
      log(`baseline upstream ${upstreamHead.slice(0, 8)}`);
    }
    return;
  }

  try {
    await postDm(digest!);
    const next: State = {
      lastFingerprint: fp,
      upstreamLastSeen: upstreamHead ?? state.upstreamLastSeen,
      lastNotifiedAt: new Date().toISOString(),
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
    log(`notifié (fp=${fp}${upstream ? `, upstream +${upstream.count}` : ''})`);
  } catch (e) {
    // État inchangé → retry au prochain passage.
    log(`post échoué (${e instanceof Error ? e.message : e}) — état conservé, retry demain`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

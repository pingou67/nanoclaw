/**
 * Dashboard health collectors — fork extension (not part of the upstream
 * /add-dashboard skill). Collects operational health signals that the stock
 * snapshot doesn't cover and that have bitten this install before:
 *
 *  - Claude OAuth token expiry + the systemd refresh timer state (401 outage
 *    of 2026-07-03: the refresh script silently failed for 2 days)
 *  - Google OAuth token files present for every group whose MCP config
 *    references them (a configured server with no token = agent-visible 401)
 *  - agy (Antigravity) host OAuth token presence
 *  - OneCLI web UI reachability
 *  - systemd maintenance timers (rtk update, upstream watch, token refresh)
 *  - rtk token savings (host + per-session containers)
 *  - per-session runtime: persisted bg jobs, live_enabled, continuation keys
 *  - last E2E run marker (written by tests/integration/mattermost/run_suite.py)
 *  - skills-sync drift (throttled — one check per hour)
 *
 * The dashboard UI has no dedicated page for these (no upstream PR by
 * design), so consumers are: the raw snapshot (`health` / `session_runtime`
 * keys, queryable via the ingest store) and the Logs page — status *changes*
 * are pushed as synthetic log lines by healthLogLines().
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFile } from 'child_process';
import Database from 'better-sqlite3';

import { getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';

export interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'error' | 'info';
  detail: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');

/* ------------------------------------------------------------------ */
/* Claude OAuth                                                        */
/* ------------------------------------------------------------------ */

export function findClaudeCredentials(): string | null {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR,
    path.join(os.homedir(), '.claude-anthropic'),
    path.join(os.homedir(), '.claude'),
  ].filter((d): d is string => !!d);
  for (const dir of candidates) {
    const p = path.join(dir, '.credentials.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Pure classifier so the thresholds are unit-testable. */
export function classifyClaudeExpiry(expiresAt: number, now: number): HealthCheck {
  const minLeft = Math.round((expiresAt - now) / 60_000);
  if (minLeft <= 0) {
    return {
      name: 'claude-oauth',
      status: 'error',
      detail: `token expiré depuis ${-minLeft} min — les containers Claude vont répondre 401`,
    };
  }
  if (minLeft < 90) {
    return {
      name: 'claude-oauth',
      status: 'warn',
      detail: `token expire dans ${minLeft} min — le timer claude-token-refresh doit tourner avant`,
    };
  }
  return {
    name: 'claude-oauth',
    status: 'ok',
    detail: `token valide ${Math.round(minLeft / 60)} h ${minLeft % 60} min`,
  };
}

function checkClaudeOauth(): HealthCheck {
  const credPath = findClaudeCredentials();
  if (!credPath) return { name: 'claude-oauth', status: 'error', detail: 'aucun .credentials.json trouvé' };
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as { claudeAiOauth?: { expiresAt?: number } };
    const expiresAt = creds.claudeAiOauth?.expiresAt;
    if (!expiresAt) return { name: 'claude-oauth', status: 'warn', detail: `pas de champ expiresAt dans ${credPath}` };
    return classifyClaudeExpiry(expiresAt, Date.now());
  } catch (err) {
    return { name: 'claude-oauth', status: 'error', detail: `credentials illisibles: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ */
/* systemd timers                                                      */
/* ------------------------------------------------------------------ */

const TIMER_UNITS = ['claude-token-refresh', 'nanoclaw-rtk-update', 'nanoclaw-upstream-watch'];

function checkTimerUnit(unit: string): Promise<HealthCheck> {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'show', `${unit}.service`, '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainExitTimestamp'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve({ name: `timer:${unit}`, status: 'info', detail: 'systemctl indisponible (non-Linux ?)' });
          return;
        }
        const props = Object.fromEntries(
          stdout
            .trim()
            .split('\n')
            .map((l) => l.split('=', 2) as [string, string]),
        );
        const result = props['Result'] ?? '';
        const lastRun = props['ExecMainExitTimestamp'] || 'jamais';
        if (result === 'success' || result === '') {
          resolve({ name: `timer:${unit}`, status: 'ok', detail: `dernier run OK (${lastRun})` });
        } else {
          resolve({
            name: `timer:${unit}`,
            status: 'error',
            detail: `dernier run: ${result} (exit=${props['ExecMainStatus'] ?? '?'}, ${lastRun})`,
          });
        }
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* OneCLI web UI                                                       */
/* ------------------------------------------------------------------ */

function checkOneCli(): Promise<HealthCheck> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: 10254, path: '/', timeout: 3000 }, (res) => {
      res.resume();
      resolve({ name: 'onecli-ui', status: 'ok', detail: `répond (${res.statusCode})` });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ name: 'onecli-ui', status: 'warn', detail: 'timeout sur 127.0.0.1:10254' });
    });
    req.on('error', (err) => {
      resolve({
        name: 'onecli-ui',
        status: 'error',
        detail: `injoignable: ${(err as NodeJS.ErrnoException).code ?? err.message}`,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Google / agy credential files referenced by MCP configs             */
/* ------------------------------------------------------------------ */

/** Map a /workspace/agent/… container path to the group folder on the host. */
export function containerPathToHost(groupFolder: string, containerPath: string): string | null {
  const prefix = '/workspace/agent/';
  if (!containerPath.startsWith(prefix)) return null;
  return path.resolve(process.cwd(), 'groups', groupFolder, containerPath.slice(prefix.length));
}

function checkMcpCredentialFiles(): HealthCheck[] {
  const checks: HealthCheck[] = [];
  let agyUsed = false;
  for (const group of getAllAgentGroups()) {
    const config = getContainerConfig(group.id);
    if (!config) continue;
    if (config.provider === 'agy') agyUsed = true;
    let servers: Record<string, { env?: Record<string, string> }> = {};
    try {
      servers = JSON.parse(config.mcp_servers || '{}');
    } catch {
      servers = {};
    }
    for (const [serverName, server] of Object.entries(servers)) {
      for (const value of Object.values(server.env ?? {})) {
        if (!/\.(json|keys\.json)$/.test(value)) continue;
        const hostPath = containerPathToHost(group.folder, value);
        if (!hostPath) continue;
        if (!fs.existsSync(hostPath)) {
          checks.push({
            name: `mcp-cred:${group.folder}/${serverName}`,
            status: 'error',
            detail: `fichier manquant: ${path.relative(process.cwd(), hostPath)} (référencé par l'env du serveur MCP)`,
          });
        }
      }
    }
  }
  if (agyUsed) {
    const agyToken = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    checks.push(
      fs.existsSync(agyToken)
        ? { name: 'agy-oauth', status: 'ok', detail: 'token Antigravity présent' }
        : {
            name: 'agy-oauth',
            status: 'error',
            detail: `token Antigravity absent (${agyToken}) — les groupes agy ne peuvent pas s'authentifier`,
          },
    );
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* rtk savings                                                         */
/* ------------------------------------------------------------------ */

function sumRtkDb(dbPath: string): { commands: number; saved: number } | null {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT count(*) AS n, coalesce(sum(saved_tokens),0) AS saved FROM commands').get() as {
        n: number;
        saved: number;
      };
      return { commands: row.n, saved: row.saved };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function collectRtkSavings(): HealthCheck {
  let commands = 0;
  let saved = 0;
  let sources = 0;
  const hostDb = path.join(os.homedir(), '.local', 'share', 'rtk', 'history.db');
  const hostSum = sumRtkDb(hostDb);
  if (hostSum) {
    commands += hostSum.commands;
    saved += hostSum.saved;
    sources += 1;
  }
  // Per-session opencode plugin stats: data/v2-sessions/<gid>/<sid>/opencode-xdg/rtk/history.db
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  try {
    for (const gid of fs.readdirSync(sessionsRoot)) {
      const groupDir = path.join(sessionsRoot, gid);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      for (const sid of fs.readdirSync(groupDir)) {
        const rtkDb = path.join(groupDir, sid, 'opencode-xdg', 'rtk', 'history.db');
        const sum = fs.existsSync(rtkDb) ? sumRtkDb(rtkDb) : null;
        if (sum) {
          commands += sum.commands;
          saved += sum.saved;
          sources += 1;
        }
      }
    }
  } catch {
    /* sessions dir may not exist yet */
  }
  return {
    name: 'rtk-savings',
    status: 'info',
    detail: `${saved.toLocaleString('fr-FR')} tokens économisés sur ${commands} commandes (${sources} source(s))`,
  };
}

/* ------------------------------------------------------------------ */
/* Per-session runtime (bg jobs, live_enabled, continuations)          */
/* ------------------------------------------------------------------ */

export interface SessionRuntime {
  agent_group_id: string;
  session_dir: string;
  bg_jobs: Array<{ jobId: string; startedAt: number; actions: number; lastAction: string; prompt: string }>;
  live_enabled: boolean;
  continuations: string[];
}

export function collectSessionRuntime(): SessionRuntime[] {
  const out: SessionRuntime[] = [];
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  let groupDirs: string[] = [];
  try {
    groupDirs = fs.readdirSync(sessionsRoot).filter((d) => d.startsWith('ag-'));
  } catch {
    return out;
  }
  for (const gid of groupDirs) {
    const groupDir = path.join(sessionsRoot, gid);
    let sessionDirs: string[] = [];
    try {
      sessionDirs = fs.readdirSync(groupDir).filter((d) => d.startsWith('sess-'));
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      const outboundPath = path.join(groupDir, sid, 'outbound.db');
      if (!fs.existsSync(outboundPath)) continue;
      try {
        const db = new Database(outboundPath, { readonly: true, fileMustExist: true });
        try {
          const rows = db.prepare('SELECT key, value FROM session_state').all() as Array<{
            key: string;
            value: string;
          }>;
          const state = new Map(rows.map((r) => [r.key, r.value]));
          let bgJobs: SessionRuntime['bg_jobs'] = [];
          try {
            bgJobs = JSON.parse(state.get('bg_jobs') ?? '[]');
          } catch {
            bgJobs = [];
          }
          out.push({
            agent_group_id: gid,
            session_dir: sid,
            bg_jobs: bgJobs,
            live_enabled: (state.get('live_enabled') ?? 'true') === 'true',
            continuations: rows.map((r) => r.key).filter((k) => k.startsWith('continuation:')),
          });
        } finally {
          db.close();
        }
      } catch {
        /* container may hold the file exclusively for a moment — skip */
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* E2E marker + skills-sync (throttled)                                */
/* ------------------------------------------------------------------ */

function checkE2eMarker(): HealthCheck {
  const marker = path.resolve(process.cwd(), 'logs', 'e2e-last-run.json');
  if (!fs.existsSync(marker)) return { name: 'e2e-last-run', status: 'info', detail: 'aucun run E2E enregistré' };
  try {
    const m = JSON.parse(fs.readFileSync(marker, 'utf-8')) as {
      timestamp: string;
      passed: number;
      failed: number;
      skipped?: number;
    };
    const ageDays = Math.floor((Date.now() - Date.parse(m.timestamp)) / 86_400_000);
    const summary = `${m.passed} ✓ / ${m.failed} ✗${m.skipped ? ` / ${m.skipped} ⤼` : ''}, il y a ${ageDays} j`;
    return { name: 'e2e-last-run', status: m.failed > 0 ? 'warn' : 'ok', detail: summary };
  } catch (err) {
    return { name: 'e2e-last-run', status: 'warn', detail: `marqueur illisible: ${(err as Error).message}` };
  }
}

let skillsSyncCache: HealthCheck = { name: 'skills-sync', status: 'info', detail: 'pas encore vérifié' };
let skillsSyncLastRun = 0;
const SKILLS_SYNC_INTERVAL_MS = 60 * 60 * 1000;

function refreshSkillsSync(): void {
  if (Date.now() - skillsSyncLastRun < SKILLS_SYNC_INTERVAL_MS) return;
  skillsSyncLastRun = Date.now();
  const tsx = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
  const script = path.resolve(process.cwd(), 'scripts', 'skills-sync.ts');
  if (!fs.existsSync(tsx) || !fs.existsSync(script)) return;
  execFile(tsx, [script, 'check'], { timeout: 120_000 }, (err, stdout, stderr) => {
    if (err) {
      const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-3).join(' | ');
      skillsSyncCache = { name: 'skills-sync', status: 'error', detail: `drift détecté: ${tail}` };
    } else {
      skillsSyncCache = { name: 'skills-sync', status: 'ok', detail: 'aucun drift skills↔branches' };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/**
 * Flag sessions whose persisted continuations don't include the group's
 * CURRENT provider while older providers' ones linger. Benign by design
 * (provider switching is lossless), but it's the fingerprint to look at
 * when a switched group answers "Model not found" — the documented fix is
 * purging the stale `continuation:<provider>` row.
 */
export function checkContinuationMismatches(runtimes: SessionRuntime[]): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const rt of runtimes) {
    if (rt.continuations.length === 0) continue;
    const config = getContainerConfig(rt.agent_group_id);
    const provider = (config?.provider ?? 'claude').toLowerCase();
    const current = `continuation:${provider}`;
    if (!rt.continuations.includes(current)) {
      checks.push({
        name: `continuation:${rt.agent_group_id}`,
        status: 'info',
        detail: `pas de continuation pour le provider courant (${provider}) mais ${rt.continuations.join(', ')} présente(s) — normal après un switch ; à purger si « Model not found »`,
      });
    }
  }
  return checks;
}

export async function collectHealth(): Promise<HealthCheck[]> {
  refreshSkillsSync(); // async fire-and-forget, served from cache
  const [timers, onecli] = await Promise.all([Promise.all(TIMER_UNITS.map(checkTimerUnit)), checkOneCli()]);
  const checks = [
    checkClaudeOauth(),
    ...timers,
    onecli,
    ...checkMcpCredentialFiles(),
    collectRtkSavings(),
    checkE2eMarker(),
    skillsSyncCache,
    ...checkContinuationMismatches(collectSessionRuntime()),
  ];
  // The dashboard package has no API route for custom snapshot keys (and no
  // upstream PR by design), so also persist the latest result locally —
  // `cat data/health.json` gives the same view without the browser.
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'health.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), checks }, null, 2),
    );
  } catch {
    /* best effort */
  }
  return checks;
}

/**
 * Turn health state *changes* into synthetic log lines for the dashboard's
 * Logs page (the only always-visible surface without UI changes). Quiet by
 * design: a check only produces a line when its status changes, plus one
 * summary line at startup.
 */
const lastStatuses = new Map<string, string>();

export function healthLogLines(checks: HealthCheck[]): string[] {
  const lines: string[] = [];
  const first = lastStatuses.size === 0;
  for (const c of checks) {
    const prev = lastStatuses.get(c.name);
    lastStatuses.set(c.name, c.status);
    if (c.status === 'info') continue;
    if (prev === c.status) continue;
    if (first && c.status === 'ok') continue; // don't spam OKs at boot
    const level = c.status === 'ok' ? 'INFO' : c.status === 'warn' ? 'WARN' : 'ERROR';
    lines.push(`[health] ${level} ${c.name}: ${c.detail}`);
  }
  if (first) {
    const bad = checks.filter((c) => c.status === 'warn' || c.status === 'error').length;
    lines.push(`[health] INFO démarrage — ${checks.length} checks, ${bad} en anomalie`);
  }
  return lines;
}

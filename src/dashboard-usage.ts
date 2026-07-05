/**
 * Dashboard usage collectors — fork extension (see also dashboard-health.ts).
 *
 * The stock pusher only scans Claude Code transcripts (.claude-shared/
 * projects/*.jsonl), so the Overview's "By Model" and "Context Windows"
 * sections were Claude-only. This module adds the OpenCode side by reading
 * each session's `opencode-xdg/opencode/opencode.db` (message rows carry
 * `data.tokens.{input,output,cache.read,cache.write}` + `data.modelID`).
 *
 * agy (Antigravity) exposes NO token usage anywhere on disk (transcripts and
 * conversation DBs are count-free) — Gemini groups therefore appear in the
 * per-channel recap but not in token stats. Documented limitation.
 *
 * Also builds the per-channel agents recap (MCP servers + derived access
 * rights) written to data/agents-recap.md — the DB is the source of truth
 * for access rights (container_configs), this is its readable projection.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAllMessagingGroups, getMessagingGroupAgents } from './db/messaging-groups.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');

export interface TokenEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  agentGroupId: string;
  /** Aggregated entries carry their real request count (default 1). */
  requests?: number;
}

/** Best-effort context ceilings for non-Claude models (display only). */
export function maxContextForModel(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('minimax')) return 1_000_000;
  if (m.includes('gemini')) return 1_048_576;
  if (m.includes('deepseek')) return 128_000;
  if (m.includes('gemma')) return 128_000;
  return 200_000;
}

function eachOpenCodeDb(cb: (agentGroupId: string, dbPath: string) => void): void {
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  let groupDirs: string[] = [];
  try {
    groupDirs = fs.readdirSync(sessionsRoot).filter((d) => d.startsWith('ag-'));
  } catch {
    return;
  }
  for (const gid of groupDirs) {
    let sessionDirs: string[] = [];
    try {
      sessionDirs = fs.readdirSync(path.join(sessionsRoot, gid)).filter((d) => d.startsWith('sess-'));
    } catch {
      continue;
    }
    for (const sid of sessionDirs) {
      const dbPath = path.join(sessionsRoot, gid, sid, 'opencode-xdg', 'opencode', 'opencode.db');
      if (fs.existsSync(dbPath)) cb(gid, dbPath);
    }
  }
}

/**
 * Aggregated token usage from every OpenCode session DB, one entry per
 * (model, agent group). Shape matches the pusher's Claude jsonl entries so
 * the existing byModel/byGroup aggregation picks them up untouched.
 */
export function collectOpenCodeTokens(): TokenEntry[] {
  const out: TokenEntry[] = [];
  eachOpenCodeDb((agentGroupId, dbPath) => {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare(
            `SELECT json_extract(data,'$.modelID') AS model,
                    count(*) AS requests,
                    coalesce(sum(json_extract(data,'$.tokens.input')),0) AS input,
                    coalesce(sum(json_extract(data,'$.tokens.output')),0) AS output,
                    coalesce(sum(json_extract(data,'$.tokens.cache.read')),0) AS cacheRead,
                    coalesce(sum(json_extract(data,'$.tokens.cache.write')),0) AS cacheWrite
             FROM message
             WHERE json_extract(data,'$.role') = 'assistant' AND json_extract(data,'$.modelID') IS NOT NULL
             GROUP BY 1`,
          )
          .all() as Array<{
          model: string;
          requests: number;
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
        }>;
        for (const r of rows) {
          out.push({
            model: r.model,
            requests: r.requests,
            inputTokens: r.input,
            outputTokens: r.output,
            cacheReadTokens: r.cacheRead,
            cacheCreationTokens: r.cacheWrite,
            agentGroupId,
          });
        }
      } finally {
        db.close();
      }
    } catch {
      /* WAL held exclusively for a moment, or foreign schema — skip */
    }
  });
  return out;
}

/**
 * Latest context-window usage per OpenCode session — same shape as the
 * pusher's Claude entries so the Overview section renders both.
 */
export function collectOpenCodeContextWindows(): unknown[] {
  const nameMap = new Map(getAllAgentGroups().map((g) => [g.id, g.name]));
  // Newest entry per agent group only — mirrors the Claude collector (one
  // line per group), otherwise long-gone experiment sessions pile up.
  const byGroup = new Map<string, { ts: number; entry: unknown }>();
  const results: unknown[] = [];
  eachOpenCodeDb((agentGroupId, dbPath) => {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const r = db
          .prepare(
            `SELECT json_extract(data,'$.modelID') AS model,
                    json_extract(data,'$.tokens.input') AS input,
                    json_extract(data,'$.tokens.output') AS output,
                    json_extract(data,'$.tokens.cache.read') AS cacheRead,
                    json_extract(data,'$.tokens.cache.write') AS cacheWrite,
                    time_created AS ts
             FROM message
             WHERE json_extract(data,'$.role') = 'assistant' AND json_extract(data,'$.tokens.input') IS NOT NULL
             ORDER BY time_created DESC LIMIT 1`,
          )
          .get() as
          | { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; ts: number }
          | undefined;
        if (!r || !r.model) return;
        const ctx = (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
        const max = maxContextForModel(r.model);
        const entry = {
          agentGroupId,
          agentGroupName: nameMap.get(agentGroupId),
          sessionId: path.basename(path.dirname(path.dirname(path.dirname(dbPath)))),
          model: r.model,
          contextTokens: ctx,
          outputTokens: r.output || 0,
          cacheReadTokens: r.cacheRead || 0,
          cacheCreationTokens: r.cacheWrite || 0,
          maxContext: max,
          usagePercent: max > 0 ? Math.round((ctx / max) * 100) : 0,
          timestamp: new Date(r.ts).toISOString(),
        };
        const prev = byGroup.get(agentGroupId);
        if (!prev || r.ts > prev.ts) byGroup.set(agentGroupId, { ts: r.ts, entry });
      } finally {
        db.close();
      }
    } catch {
      /* skip */
    }
  });
  results.push(...Array.from(byGroup.values()).map((v) => v.entry));
  return results;
}

/* ------------------------------------------------------------------ */
/* Per-channel agents recap                                            */
/* ------------------------------------------------------------------ */

interface McpServerConfigLite {
  env?: Record<string, string>;
  instructions?: string;
}

/** Human-readable access rights derived from a group's container config. */
export function deriveAccessRights(config: {
  mcp_servers: string;
  additional_mounts: string;
  cli_scope: string;
}): string[] {
  const rights: string[] = [];
  let servers: Record<string, McpServerConfigLite> = {};
  let mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }> = [];
  try {
    servers = JSON.parse(config.mcp_servers || '{}');
  } catch {
    /* ignore */
  }
  try {
    mounts = JSON.parse(config.additional_mounts || '[]');
  } catch {
    /* ignore */
  }

  const hasImapMount = mounts.some((m) => m.hostPath.includes('.imap-mcp'));
  for (const [name, server] of Object.entries(servers)) {
    if (name === 'nanoclaw') continue;
    if (name === 'gmail' || name === 'gmail-perso') {
      rights.push('Gmail perso (complet)');
    } else if (name === 'google-calendar') {
      const instr = server.instructions ?? '';
      rights.push(
        /lecture seule|écriture/i.test(instr)
          ? 'Google Calendar (restreint — voir instructions)'
          : 'Google Calendar (complet)',
      );
    } else if (name === 'imap') {
      rights.push(hasImapMount ? 'Mail Unistra (imap)' : 'Mail Unistra (imap) ⚠ mount .imap-mcp absent');
    } else if (name === 'vikunja') {
      const scope = server.env?.VIKUNJA_PROJECT_SCOPE ?? 'ALL';
      rights.push(scope === 'ALL' || scope === '' ? 'Vikunja (tous projets)' : `Vikunja (projet ${scope})`);
    } else if (name === 'memory') {
      rights.push('Mémoire persistante');
    } else {
      rights.push(`MCP ${name}`);
    }
  }
  for (const m of mounts) {
    if (m.hostPath.includes('.imap-mcp')) continue; // already reported via imap
    rights.push(`Mount ${m.readonly === false ? 'RW' : 'RO'} ${m.hostPath}`);
  }
  if (config.cli_scope === 'global') rights.push('ncl GLOBAL (admin complet)');
  return rights;
}

export interface RecapRow {
  channel: string;
  folder: string;
  provider: string;
  model: string;
  /** Reasoning effort (low…max) — null when the group uses the default. */
  effort: string | null;
  /** Thinking mode ('adaptive' | 'enabled' | 'disabled') — null if unset. */
  thinking: string | null;
  engage: string;
  mcp: string[];
  rights: string[];
}

/** Structured per-channel recap rows — pushed in the snapshot (`agents_recap`)
 * for the patched dashboard "Agents" page, and rendered to markdown below. */
export function buildAgentsRecapRows(): RecapRow[] {
  const groups = new Map(getAllAgentGroups().map((g) => [g.id, g]));
  const rows: RecapRow[] = [];
  for (const mg of getAllMessagingGroups()) {
    for (const wiring of getMessagingGroupAgents(mg.id)) {
      const group = groups.get(wiring.agent_group_id);
      if (!group) continue;
      const config = getContainerConfig(group.id);
      let mcpNames: string[] = [];
      try {
        mcpNames = Object.keys(JSON.parse(config?.mcp_servers || '{}')).filter((n) => n !== 'nanoclaw');
      } catch {
        /* ignore */
      }
      const rights = config ? deriveAccessRights(config) : [];
      // Home Assistant is file-based (assumed exception to the DB principle)
      if (fs.existsSync(path.resolve(process.cwd(), 'groups', group.folder, 'ha_credentials.json'))) {
        rights.push('Home Assistant (REST)');
      }
      rows.push({
        channel: mg.name ?? mg.id,
        folder: group.folder,
        provider: config?.provider || 'claude',
        model: config?.model || '(défaut)',
        effort: config?.effort ?? null,
        thinking: (() => {
          try {
            return config?.thinking ? ((JSON.parse(config.thinking) as { type?: string }).type ?? null) : null;
          } catch {
            return null;
          }
        })(),
        engage: wiring.engage_mode === 'mention' ? 'mention' : `pattern ${wiring.engage_pattern ?? '.'}`,
        mcp: mcpNames,
        rights,
      });
    }
  }
  rows.sort((a, b) => a.channel.localeCompare(b.channel));
  return rows;
}

export function buildAgentsRecap(): string {
  const lines: string[] = [
    '# Agents par channel — récap généré',
    '',
    `_Généré par le dashboard pusher le ${new Date().toISOString()} — source de vérité : container_configs (DB centrale). Ne pas éditer._`,
    '',
    "| Channel | Agent group | Provider / Modèle | Déclenchement | MCP actifs | Droits d'accès |",
    '|---|---|---|---|---|---|',
  ];
  for (const r of buildAgentsRecapRows()) {
    lines.push(
      `| ${r.channel} | ${r.folder} | ${r.provider} / ${r.model}${r.effort ? ` (effort ${r.effort}` + (r.thinking ? `, thinking ${r.thinking})` : ')') : r.thinking ? ` (thinking ${r.thinking})` : ''} | ${r.engage} | ${r.mcp.join(', ') || '—'} | ${r.rights.join(' · ') || '—'} |`,
    );
  }
  lines.push('');
  lines.push('Notes :');
  lines.push('- « Gmail perso » = compte ppegon@gmail.com, OAuth par groupe dans son dossier `groups/<folder>/`.');
  lines.push('- Les groupes agy (Gemini) ne remontent PAS de stats tokens (Antigravity ne les expose pas).');
  lines.push(
    '- Le détail des restrictions vit dans le champ `instructions` des serveurs MCP (`ncl groups config get`).',
  );
  return lines.join('\n');
}

/** Write the recap next to health.json; called from the pusher each cycle. */
export function writeAgentsRecap(): void {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'agents-recap.md'), buildAgentsRecap());
  } catch {
    /* best effort */
  }
}

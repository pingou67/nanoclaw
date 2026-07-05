/**
 * Dashboard write actions — fork extension, invoked by the pnpm-patched
 * dashboard package via its `onAction` hook (POST /api/actions, guarded by
 * the dedicated DASHBOARD_WRITE_SECRET).
 *
 * Deliberately a WHITELIST, not a generic config editor: only
 * effort / model / thinking, the per-session live-status toggle, and a
 * group restart. `env`, `additional_mounts`, `cli_scope`, roles and every
 * other column are structurally unreachable from here — extending the
 * surface means editing this file, not adding a request parameter.
 *
 * Every accepted AND refused action is audited as a `[action]` line via the
 * host logger — the pusher tails the log to the dashboard, so the audit
 * trail is visible on the Logs page itself.
 */
import { getAgentGroup } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getContainerConfig, updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { restartAgentGroupContainers } from './container-restart.js';
import { writeSessionMessage, openInboundDb } from './session-manager.js';
import { insertTask, updateTask, cancelTask, pauseTask, resumeTask } from './modules/scheduling/db.js';
import { log } from './log.js';

export interface DashboardActionRequest {
  action: string;
  agentGroupId?: string;
  field?: string;
  value?: string | null;
  /** Job actions (job-add / job-update / job-cancel / job-pause / job-resume). */
  sessionDir?: string;
  taskId?: string;
  prompt?: string;
  processAfter?: string;
  recurrence?: string | null;
}

export interface DashboardActionResult {
  ok: boolean;
  message: string;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const THINKING = new Set(['adaptive', 'enabled', 'disabled', 'none']);
/** Model ids: aliases (opus), full ids, provider-prefixed (a/b/c). */
const MODEL_RE = /^[\w.:\/-]{1,120}$/;

function audit(line: string): void {
  log.info(`[action] ${line}`);
}

function refuse(reason: string, req: DashboardActionRequest): DashboardActionResult {
  audit(`REFUSÉ ${req.action}${req.field ? ` ${req.field}` : ''} group=${req.agentGroupId ?? '?'} — ${reason}`);
  return { ok: false, message: reason };
}

export async function handleDashboardAction(req: DashboardActionRequest): Promise<DashboardActionResult> {
  const gid = req.agentGroupId ?? '';
  const group = getAgentGroup(gid);
  if (!group) return refuse(`agent group inconnu: ${gid}`, req);

  switch (req.action) {
    case 'set-config': {
      const { field } = req;
      const value = req.value === '' ? null : (req.value ?? null);
      if (field === 'effort') {
        if (value !== null && !EFFORTS.has(value)) return refuse(`effort invalide: ${value}`, req);
        updateContainerConfigScalars(gid, { effort: value });
      } else if (field === 'model') {
        if (value !== null && !MODEL_RE.test(value))
          return refuse('modèle invalide (1-120 chars, [A-Za-z0-9._:/-])', req);
        updateContainerConfigScalars(gid, { model: value });
      } else if (field === 'thinking') {
        if (value !== null && !THINKING.has(value)) return refuse(`thinking invalide: ${value}`, req);
        updateContainerConfigJson(gid, 'thinking', value === null || value === 'none' ? null : { type: value });
      } else {
        // env / mounts / cli_scope / anything else: not on the whitelist.
        return refuse(`champ non modifiable depuis le dashboard: ${field ?? '(absent)'}`, req);
      }
      audit(`set-config ${field}=${value ?? '(défaut)'} group=${group.folder} (via dashboard)`);
      return { ok: true, message: `${field} → ${value ?? '(défaut)'} — effectif au prochain restart du groupe` };
    }

    case 'restart-group': {
      const n = restartAgentGroupContainers(gid, 'dashboard action');
      audit(`restart-group group=${group.folder} containers=${n} (via dashboard)`);
      return {
        ok: true,
        message:
          n > 0 ? `${n} container(s) redémarré(s)` : 'aucun container actif — la config sera prise au prochain message',
      };
    }

    case 'toggle-live': {
      // live_enabled lives in the session's outbound.db, owned by the
      // CONTAINER (single-writer rule) — the host must not write it. Instead
      // we inject the runner's own `!live` command as an inbound message; the
      // poll loop toggles the setting and acks in the channel (visible trace).
      const sessions = getSessionsByAgentGroup(gid)
        .filter((s) => s.status === 'active')
        .sort((a, b) => (b.last_active ?? '').localeCompare(a.last_active ?? ''));
      const session = sessions[0];
      if (!session) return refuse('aucune session active pour ce groupe', req);
      const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
      if (!mg) return refuse('session sans messaging group résoluble', req);
      writeSessionMessage(gid, session.id, {
        id: `dash-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: mg.platform_id,
        channelType: mg.channel_type,
        threadId: session.thread_id ?? null,
        content: JSON.stringify({ text: '!live', sender: 'dashboard', senderId: 'dashboard' }),
      });
      audit(`toggle-live group=${group.folder} session=${session.id} (via dashboard, commande !live injectée)`);
      return {
        ok: true,
        message: 'commande !live envoyée — le container ack dans le channel (à la prochaine minute si endormi)',
      };
    }

    case 'job-add': {
      const prompt = (req.prompt ?? '').trim();
      if (!prompt || prompt.length > 4000) return refuse('prompt requis (1-4000 caractères)', req);
      const when = req.processAfter ?? '';
      if (!when || Number.isNaN(Date.parse(when))) return refuse(`échéance invalide: ${when}`, req);
      const recurrence = normalizeCron(req.recurrence);
      if (recurrence === false) return refuse(`récurrence invalide (cron 5 champs attendu): ${req.recurrence}`, req);
      const session = latestActiveSession(gid);
      if (!session) return refuse('aucune session active pour ce groupe', req);
      const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insertTask(openInboundDb(gid, session.id), {
        id: taskId,
        processAfter: new Date(when).toISOString(),
        recurrence,
        platformId: mg?.platform_id ?? null,
        channelType: mg?.channel_type ?? null,
        threadId: session.thread_id ?? null,
        content: JSON.stringify({ prompt }),
      });
      audit(`job-add ${taskId} group=${group.folder} processAfter=${when} recurrence=${recurrence ?? '(ponctuelle)'} (via dashboard)`);
      return { ok: true, message: `tâche ${taskId} créée` };
    }

    case 'job-update': {
      const target = requireTask(req);
      if ('error' in target) return refuse(target.error, req);
      const update: { prompt?: string; processAfter?: string; recurrence?: string | null } = {};
      if (req.prompt !== undefined) {
        const p = req.prompt.trim();
        if (!p || p.length > 4000) return refuse('prompt invalide (1-4000 caractères)', req);
        update.prompt = p;
      }
      if (req.processAfter !== undefined && req.processAfter !== '') {
        if (Number.isNaN(Date.parse(req.processAfter))) return refuse(`échéance invalide: ${req.processAfter}`, req);
        update.processAfter = new Date(req.processAfter).toISOString();
      }
      if (req.recurrence !== undefined) {
        const recurrence = normalizeCron(req.recurrence);
        if (recurrence === false) return refuse(`récurrence invalide: ${req.recurrence}`, req);
        update.recurrence = recurrence;
      }
      const n = updateTask(openInboundDb(gid, target.sessionId), target.taskId, update);
      if (n === 0) return refuse(`tâche introuvable (ou plus pending/paused): ${target.taskId}`, req);
      audit(`job-update ${target.taskId} group=${group.folder} champs=${Object.keys(update).join(',')} (via dashboard)`);
      return { ok: true, message: `tâche mise à jour (${n} ligne(s))` };
    }

    case 'job-cancel': {
      const target = requireTask(req);
      if ('error' in target) return refuse(target.error, req);
      cancelTask(openInboundDb(gid, target.sessionId), target.taskId);
      audit(`job-cancel ${target.taskId} group=${group.folder} (via dashboard)`);
      return { ok: true, message: `tâche ${target.taskId} supprimée` };
    }

    case 'job-pause':
    case 'job-resume': {
      const target = requireTask(req);
      if ('error' in target) return refuse(target.error, req);
      const db = openInboundDb(gid, target.sessionId);
      if (req.action === 'job-pause') pauseTask(db, target.taskId);
      else resumeTask(db, target.taskId);
      audit(`${req.action} ${target.taskId} group=${group.folder} (via dashboard)`);
      return { ok: true, message: `tâche ${req.action === 'job-pause' ? 'mise en pause' : 'reprise'}` };
    }

    default:
      return refuse(`action inconnue: ${req.action}`, req);
  }
}

/** Cron sanity: null/'' → null (one-shot); otherwise exactly 5 whitespace-separated fields. */
function normalizeCron(raw: string | null | undefined): string | null | false {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const c = raw.trim();
  return /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(c) ? c : false;
}

function latestActiveSession(gid: string) {
  return getSessionsByAgentGroup(gid)
    .filter((s) => s.status === 'active')
    .sort((a, b) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))[0];
}

/** Resolve and validate the (sessionDir, taskId) pair of a job action. */
function requireTask(req: DashboardActionRequest): { sessionId: string; taskId: string } | { error: string } {
  const sid = req.sessionDir ?? '';
  const taskId = req.taskId ?? '';
  if (!/^sess-[\w-]+$/.test(sid)) return { error: `sessionDir invalide: ${sid}` };
  if (!/^[\w-]{1,80}$/.test(taskId)) return { error: `taskId invalide: ${taskId}` };
  const session = getSessionsByAgentGroup(req.agentGroupId ?? '').find((s) => s.id === sid);
  if (!session) return { error: `session ${sid} inconnue pour ce groupe` };
  return { sessionId: sid, taskId };
}

/** Config summary used by the UI to prefill controls (read via /api/agents-recap). */
export function currentConfigSummary(gid: string): { effort: string | null; model: string | null } {
  const c = getContainerConfig(gid);
  return { effort: c?.effort ?? null, model: c?.model ?? null };
}

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
import { writeSessionMessage } from './session-manager.js';
import { log } from './log.js';

export interface DashboardActionRequest {
  action: string;
  agentGroupId?: string;
  field?: string;
  value?: string | null;
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

    default:
      return refuse(`action inconnue: ${req.action}`, req);
  }
}

/** Config summary used by the UI to prefill controls (read via /api/agents-recap). */
export function currentConfigSummary(gid: string): { effort: string | null; model: string | null } {
  const c = getContainerConfig(gid);
  return { effort: c?.effort ?? null, model: c?.model ?? null };
}

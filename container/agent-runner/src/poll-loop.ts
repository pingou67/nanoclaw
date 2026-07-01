import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  releaseProcessing,
  type MessageInRow,
} from './db/messages-in.js';
import { getDeliveredPlatformId, writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  addLiveStatusPost,
  clearContinuation,
  clearLiveStatusPosts,
  getLiveEnabled,
  getLiveStatusPosts,
  migrateLegacyContinuation,
  removeLiveStatusPost,
  setContinuation,
  setLiveEnabled,
} from './db/session-state.js';
import { clearCurrentInReplyTo, getCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isBackgroundCommand,
  isLiveCommand,
  isStopCommand,
  isBgListCommand,
  isBgCancelCommand,
  parseBgCancelIds,
  isHelpCommand,
  buildHelpText,
  isRunnerCommand,
  stripInternalTags,
  stripToolMarkup,
  stripEnvelopeTags,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
/**
 * Smart auto-background threshold. When a foreground query has been running
 * for longer than this AND new user messages arrive (signal that the user is
 * actively waiting), demote the current query to background and start a
 * fresh foreground for the new messages. The user-facing trigger /background
 * has no threshold — it backgrounds immediately when used.
 *
 * Default 30s — fires reasonably quickly so the user doesn't have to wait
 * minutes when they want to interleave a quick question. Combined with the
 * `activelyProcessing` + `turnStartedAt` gates it only triggers when the
 * agent is genuinely busy on the current turn AND the user is actively
 * waiting (a new message arrived). Override with env var
 * NANOCLAW_AUTO_BG_THRESHOLD_MS — set to 0 to disable auto-bg entirely
 * (the E2E test suite does this — see tests/integration/mattermost/run_suite.py).
 */
const AUTO_BG_THRESHOLD_MS = (() => {
  const env = Number(process.env.NANOCLAW_AUTO_BG_THRESHOLD_MS);
  return Number.isFinite(env) && env >= 0 ? env : 30_000;
})();

/**
 * Minimum interval between two consecutive live-status post updates. The
 * agent can produce many tool calls per second during a bulk operation;
 * editing the Mattermost post on every one would hammer the server and
 * spam the user's screen. 2.5s is fast enough to feel live, slow enough
 * to keep the post readable.
 */
const LIVE_STATUS_THROTTLE_MS = 2_500;

/**
 * Global kill-switch for the live-status feature. When set to '1' or 'true'
 * the mechanism is disabled regardless of the per-session toggle (/live).
 * Used by the E2E test harness to keep test replies deterministic — the
 * test waits on the first reply matching a specific string, and live-status
 * intermediate posts would race with the actual answer.
 */
const LIVE_STATUS_DISABLED = (() => {
  const v = (process.env.NANOCLAW_LIVE_STATUS_DISABLED || '').toLowerCase();
  return v === '1' || v === 'true';
})();

/**
 * Maximum time the active query is allowed to go without producing any
 * SDK event. Catches the case where the Claude Agent SDK silently stops
 * after a `result` (no further events ever arrive, but the process is
 * still alive — see fix description in v2 adapter notes).
 *
 * Set well above any reasonable single-tool-call latency (Bash max is
 * 10 min, but in practice we never see more than a minute between
 * events even on long calls). 6 min is a safe ceiling: long enough to
 * avoid false positives on legitimately slow tools, short enough to
 * unblock the session well before the host-sweep ABSOLUTE_CEILING_MS
 * (30 min).
 */
const QUERY_IDLE_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Live-status post state attached to an active query. Tracks the running
 * status message in Mattermost (or any channel adapter that supports edit)
 * so we can update it in place rather than spamming the channel with one
 * post per tool call.
 */
interface LiveStatus {
  /** outbound msg id we wrote to create the status post; null until first event. */
  outboundId: string | null;
  /** platform message id (e.g. mm-postid) once the host has delivered the create. */
  platformMsgId: string | null;
  /** last time we wrote any update (create or edit); used for throttling. */
  lastUpdateAt: number;
  /** most recent progress text we received but possibly throttled. */
  latestText: string;
  /** count of progress events for "n actions" display. */
  eventCount: number;
}

export interface ActiveQuery {
  jobId: string; // 'fg' initially; mutated to `bg-${N}` on transition
  kind: 'foreground' | 'background';
  query: AgentQuery;
  originalPrompt: string;
  /** Query creation time (immutable). Used for logging only. */
  startedAt: number;
  /**
   * Current turn start time — resets to now() on every push() of a follow-up.
   * This is what auto-bg measures: AUTO_BG_THRESHOLD_MS of *active processing
   * on the current turn*, not time since the query was first created. An idle
   * SDK session (already produced result, waiting for follow-ups) is NOT a
   * candidate for auto-bg even if it was created hours ago.
   */
  turnStartedAt: number;
  /**
   * True while the SDK is mid-turn (between push/init and result). Set false
   * on result, back to true when push() is called for a follow-up. Auto-bg
   * gates on this — backgrounding an idle session is meaningless (there's
   * nothing to background).
   */
  activelyProcessing: boolean;
  /**
   * True when this query was started by an interactive message (chat /
   * chat-sdk), false when it was started purely by scheduled tasks (cron
   * weekly summary, daily reminder, news digest…). Live-status posts are
   * suppressed for non-interactive turns — the user doesn't want "🔧 …"
   * activity chatter in the channel for background scheduled work.
   */
  interactive: boolean;
  /**
   * Set true when the query is aborted (`!stop`, `!bg-cancel`, max-duration
   * reap). Providers abort SOFTLY — the flag is only observed on the next SDK
   * event, which during a long tool call can be minutes away. Meanwhile this
   * query's 500ms follow-up poller is still armed; without this flag it would
   * keep claiming new messages and pushing them into a dead stream (silently
   * swallowing them) or auto-bg-demoting the REPLACEMENT foreground query.
   */
  aborted?: boolean;
  routing: RoutingContext;
  initialBatchIds: string[];
  live: LiveStatus;
}

interface BgResult {
  jobId: string;
  originalPrompt: string;
  result: string;
  durationMs: number;
}

// Module-level state. Single-threaded JS guarantees these mutate atomically
// between awaits, no locking needed.
let activeForegroundQuery: ActiveQuery | null = null;
const activeBackgroundQueries: Map<string, ActiveQuery> = new Map();
const pendingBgResults: BgResult[] = [];
let bgJobCounter = 0;
/**
 * Set true by transitionToBackground to tell the outer loop "the next
 * foreground query must use a fresh SDK session id, not resume from the
 * persisted continuation". The persisted continuation belongs to the
 * just-demoted bg-N query, which keeps writing to that .jsonl in its own
 * SDK subprocess — sharing it with a new fg means two queries racing on the
 * same transcript file (and corrupting both transcripts).
 */
let freshFgContinuationNeeded = false;
/** Provider name captured at runPollLoop start so transitionToBackground
 * can clear the persisted continuation without taking it as a parameter. */
let runnerProviderName = '';
/** Whether the active provider delivers structurally (final text → origin, no
 * `<message to>` regex). Captured at runPollLoop start; see AgentProvider
 * `structuredDelivery`. Default false (legacy text-envelope parsing). */
let runnerStructuredDelivery = false;

/**
 * Demote the foreground query to background. Idempotent for a given fg ref —
 * no-op if already background or null. Posts a user-facing notice and clears
 * the foreground slot so the outer loop can start a fresh fg query.
 */
function transitionToBackground(reason: 'manual' | 'auto', requester?: ActiveQuery): string | null {
  const fg = activeForegroundQuery;
  if (!fg || fg.kind === 'background') return null;
  // A stale poller (its query was stopped/aborted but the SDK hasn't
  // unwound yet) must never demote the CURRENT foreground query in its
  // place — only the poller owning the live fg may demote it.
  if (requester && requester !== fg) return null;

  bgJobCounter += 1;
  const jobId = `bg-${bgJobCounter}`;
  fg.jobId = jobId;
  fg.kind = 'background';

  activeBackgroundQueries.set(jobId, fg);
  activeForegroundQuery = null;

  // The demoted query keeps its in-memory SDK session id (subprocess already
  // has it loaded), but we MUST clear the persisted continuation and signal
  // the outer loop to start the next fg with a fresh session id. Otherwise
  // bg-N and the new fg both load the same .jsonl transcript and race on
  // writes — corrupting both transcripts and bleeding context between them.
  // The bg-N's work is still posted via its in-memory query; if the
  // container dies mid-bg the bg work is lost (acceptable for bg by design).
  if (runnerProviderName) {
    clearContinuation(runnerProviderName);
  }
  freshFgContinuationNeeded = true;

  // turnStartedAt is the "current turn started" timestamp — what the user
  // perceives as "how long the agent has been working on the current message".
  // startedAt would be misleading for long-lived sessions with multiple turns.
  const elapsedS = Math.round((Date.now() - fg.turnStartedAt) / 1000);
  const notice =
    reason === 'auto'
      ? `🕐 \`${jobId}\` Cette tâche prend du temps (${elapsedS}s), je continue en background — tu peux m'envoyer autre chose, je te posterai le résultat dès qu'il est prêt.`
      : `🕐 \`${jobId}\` Tâche basculée en background — tu peux m'envoyer autre chose, je te posterai le résultat dès qu'il est prêt.`;
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: fg.routing.platformId,
    channel_type: fg.routing.channelType,
    thread_id: fg.routing.threadId,
    content: JSON.stringify({ text: notice }),
  });

  log(`Transitioned to ${jobId} (${reason})`);
  return jobId;
}

/**
 * Build an XML preamble injecting any completed background job results into
 * the next foreground prompt. The agent sees the result of each backgrounded
 * task naturally as system context — it can then act on it (e.g. "reply to
 * the urgent mail you found in bg-1"). After injection, the queue is flushed.
 */
function consumePendingBgResults(): string {
  if (pendingBgResults.length === 0) return '';
  const blocks = pendingBgResults
    .splice(0)
    .map(
      (r) =>
        `<background-result job-id="${escapeXml(r.jobId)}" duration-ms="${r.durationMs}" original-prompt="${escapeXml(r.originalPrompt.slice(0, 500))}">\n${escapeXml(r.result)}\n</background-result>`,
    )
    .join('\n');
  return `${blocks}\n\n`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Update (or create, or finalize) the live-status post for an active query.
 * `text` is the latest progress summary (e.g. "🔧 imap_search_emails(...)"),
 * or null on result/error to delete/finalize the post.
 *
 * Behavior:
 * - Disabled when getLiveEnabled() === false (per-session toggle via /live).
 * - First call: writes a regular outbound (create) and stores its id; the
 *   host will deliver it and populate `delivered.platform_message_id`.
 * - Subsequent calls: throttled to LIVE_STATUS_THROTTLE_MS. Once the
 *   platform id is known, writes an `edit` operation; if not yet known
 *   (host hasn't delivered the create yet), the update is dropped — the
 *   next throttle window will pick up the latest text.
 * Finalize (text=null) is handled by finalizeLiveStatus, not here.
 */
function updateLiveStatus(active: ActiveQuery, text: string, opts: { countAction?: boolean } = {}): void {
  // Channels that don't carry an addressable platform id (e.g. agent-to-agent
  // routing) have no concept of a status post. Skip entirely.
  if (LIVE_STATUS_DISABLED) return;
  // Scheduled-task turns run silently — no "🔧 …" activity chatter for cron
  // work (weekly summary, daily reminder, news digest…).
  if (!active.interactive) return;
  if (!active.routing.platformId || !active.routing.channelType) return;
  if (!getLiveEnabled()) return;

  const live = active.live;
  const now = Date.now();

  // The 3s refresh ticker re-renders with countAction=false — only real tool
  // events count as "actions", otherwise a single 60s tool call shows ~20
  // actions and reads as a runaway loop (the "141 actions" incident was
  // mostly refresh ticks).
  if (opts.countAction !== false) live.eventCount += 1;
  live.latestText = text;

  // Throttle: respect minimum interval since the last write.
  if (now - live.lastUpdateAt < LIVE_STATUS_THROTTLE_MS) return;

  const tag = active.kind === 'background' ? `\`${active.jobId}\` ` : '';
  const body = `${tag}🔧 ${text}\n\n_${live.eventCount} action${live.eventCount > 1 ? 's' : ''} • ${Math.round((now - active.turnStartedAt) / 1000)}s_`;

  // First call — write a create. Persist the post ref immediately so that if
  // the container dies before finalize, the next container can clean it up.
  if (!live.outboundId) {
    const newId = generateId();
    writeMessageOut({
      id: newId,
      kind: 'chat',
      platform_id: active.routing.platformId,
      channel_type: active.routing.channelType,
      thread_id: active.routing.threadId,
      content: JSON.stringify({ text: body }),
    });
    live.outboundId = newId;
    live.lastUpdateAt = now;
    addLiveStatusPost({
      outboundId: newId,
      platformMsgId: null,
      platformId: active.routing.platformId,
      channelType: active.routing.channelType,
      threadId: active.routing.threadId,
    });
    return;
  }

  // Subsequent call — try to upgrade to edit mode.
  if (!live.platformMsgId) {
    live.platformMsgId = getDeliveredPlatformId(live.outboundId);
    if (!live.platformMsgId) return; // host hasn't delivered yet; next tick.
    // Got the platform id — update the persisted ref so startup cleanup can
    // edit the post directly without re-resolving.
    addLiveStatusPost({
      outboundId: live.outboundId,
      platformMsgId: live.platformMsgId,
      platformId: active.routing.platformId,
      channelType: active.routing.channelType,
      threadId: active.routing.threadId,
    });
  }

  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: active.routing.platformId,
    channel_type: active.routing.channelType,
    thread_id: active.routing.threadId,
    content: JSON.stringify({ operation: 'edit', messageId: live.platformMsgId, text: body }),
  });
  live.lastUpdateAt = now;
}

/**
 * Finalize the live-status post at the end of a turn: edit it into a discreet
 * "✅ Terminé" marker (NOT delete — Mattermost shows an ugly "(message
 * deleted)" placeholder for ~30s). Editing requires the platform post id; if
 * the create hasn't been delivered yet (short turn), retry resolving it for a
 * few seconds before giving up. If we never resolve it, the persisted ref is
 * left in place so the next container's startup cleanup catches it.
 *
 * Async because of the bounded retry; callers await it from the event loop.
 */
async function finalizeLiveStatus(
  active: ActiveQuery,
  opts: { marker?: 'done' | 'stopped' | 'cancelled' | 'max_duration' } = {},
): Promise<void> {
  if (LIVE_STATUS_DISABLED) return;
  if (!active.routing.platformId || !active.routing.channelType) return;
  const live = active.live;
  if (!live.outboundId) return; // no status post was ever created this turn.

  // Resolve the platform id, retrying briefly for the short-turn race where
  // the create hasn't round-tripped through the host delivery poll yet.
  if (!live.platformMsgId) {
    for (let i = 0; i < 6 && !live.platformMsgId; i++) {
      live.platformMsgId = getDeliveredPlatformId(live.outboundId);
      if (live.platformMsgId) break;
      await sleep(700);
    }
  }

  if (live.platformMsgId) {
    const tag = active.kind === 'background' ? `\`${active.jobId}\` ` : '';
    const elapsedS = Math.round((Date.now() - active.turnStartedAt) / 1000);
    const actions = live.eventCount > 0 ? `, ${live.eventCount} action${live.eventCount > 1 ? 's' : ''}` : '';
    let body: string;
    switch (opts.marker) {
      case 'stopped':
        body = `${tag}⏹ _Arrêté après ${elapsedS}s${actions}_`;
        break;
      case 'cancelled':
        body = `${tag}⏹ _Annulé${actions}_`;
        break;
      case 'max_duration':
        body = `${tag}⏹ _Arrêté (max duration)${actions}_`;
        break;
      case 'done':
      default:
        body = `${tag}✅ _Terminé en ${elapsedS}s${actions}_`;
    }
    writeMessageOut({
      id: generateId(),
      kind: 'chat',
      platform_id: active.routing.platformId,
      channel_type: active.routing.channelType,
      thread_id: active.routing.threadId,
      content: JSON.stringify({ operation: 'edit', messageId: live.platformMsgId, text: body }),
    });
    // Remove only OUR slot — a concurrent query (fg vs bg) may have its own
    // live post whose ref must survive for crash cleanup.
    removeLiveStatusPost(live.outboundId);
  }
  // else: couldn't resolve — leave the persisted ref for startup cleanup.

  live.outboundId = null;
  live.platformMsgId = null;
  live.lastUpdateAt = 0;
  live.latestText = '';
  live.eventCount = 0;
}

/**
 * Abort ALL in-flight activity for this session — the foreground query and
 * every background job — and finalize each one's live-status post into a
 * "⏹ Arrêté" marker. Clears the fg slot, the bg map, and any pending bg
 * results. Returns the number of queries that were actually stopped.
 *
 * Does NOT touch the SDK continuation: /stop interrupts work but keeps the
 * conversation memory so the next message resumes normally (use /clear to
 * wipe memory).
 */
async function stopAllActivity(): Promise<number> {
  const all: ActiveQuery[] = [];
  if (activeForegroundQuery) all.push(activeForegroundQuery);
  all.push(...activeBackgroundQueries.values());

  // Clear module state first so the detached query promises' finally blocks
  // (which also null/delete these) become no-ops, and a fresh foreground can
  // start immediately once the aborted queries unwind.
  activeForegroundQuery = null;
  activeBackgroundQueries.clear();
  pendingBgResults.length = 0;

  for (const aq of all) {
    aq.aborted = true; // disarm the query's follow-up poller immediately
    try {
      aq.query.abort();
    } catch {
      /* swallow — best effort */
    }
    await finalizeLiveStatus(aq, { marker: 'stopped' });
  }
  return all.length;
}

/**
 * Maximum duration a single background job is allowed to run before being
 * auto-killed. After this many ms, the runner cancels the bg, finalizes its
 * live status with a "max duration reached" marker, and posts a user-facing
 * notice. Prevents a stuck bg (e.g. model looping on a 69s IMAP timeout) from
 * spinning actions forever — symptom in #mattermost_dm 2026-06-19: bg-1
 * reached 141 actions / 429s on a hung IMAP call.
 *
 * Configurable via NANOCLAW_BG_MAX_DURATION_MS env var (default 10 min).
 * Set to 0 to disable the auto-kill.
 */
const BG_MAX_DURATION_MS = (() => {
  const raw = process.env.NANOCLAW_BG_MAX_DURATION_MS;
  if (raw === undefined) return 10 * 60 * 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 10 * 60 * 1000;
})();

/**
 * Cancel a single background job by id (e.g. "bg-1"). Returns true if a job
 * was found and cancelled, false if no such job. Does NOT touch the
 * foreground query or other bg jobs. Aborts the SDK subprocess, finalizes
 * the live status with a "cancelled" marker, and posts a user-facing notice.
 */
async function cancelBackgroundJob(jobId: string): Promise<boolean> {
  const bg = activeBackgroundQueries.get(jobId);
  if (!bg) return false;

  activeBackgroundQueries.delete(jobId);
  bg.aborted = true; // disarm its follow-up poller
  try {
    bg.query.abort();
  } catch {
    /* swallow — best effort */
  }
  await finalizeLiveStatus(bg, { marker: 'cancelled' });
  log(`Cancelled ${jobId} via !bg-cancel`);
  return true;
}

/**
 * Cancel every running background job. Returns the number of jobs that
 * were cancelled. Foreground query is untouched (use /stop or !stop for
 * that). Idempotent — safe to call on an empty bg map.
 */
async function cancelAllBackgroundJobs(): Promise<number> {
  const ids = Array.from(activeBackgroundQueries.keys());
  let n = 0;
  for (const id of ids) {
    if (await cancelBackgroundJob(id)) n += 1;
  }
  return n;
}

/**
 * Return a one-line description per running bg job, used by the `!bg-list`
 * reply. Includes the jobId, the elapsed seconds since the bg was created
 * (not since the original fg — that's what the user perceives as "stuck"),
 * the last tool action seen on the live status, and the platform id so the
 * user knows which channel it came from.
 */
function listBackgroundJobs(): Array<{ jobId: string; elapsedS: number; lastAction: string; platformId: string | null }> {
  const out: Array<{ jobId: string; elapsedS: number; lastAction: string; platformId: string | null }> = [];
  for (const [jobId, bg] of activeBackgroundQueries) {
    out.push({
      jobId,
      elapsedS: Math.round((Date.now() - bg.turnStartedAt) / 1000),
      lastAction: bg.live.latestText || '(idle — no tool calls yet)',
      platformId: bg.routing.platformId,
    });
  }
  return out;
}

/**
 * Shared handlers for the read-only / bg-control runner commands
 * (`!bg-list`, `!bg-cancel`, `!live`). Called from BOTH the outer loop and
 * the mid-stream follow-up poller — consulting the bg list or cancelling a
 * bg must never abort the in-flight foreground turn.
 */
async function handleBgListCommand(routing: RoutingContext): Promise<void> {
  const jobs = listBackgroundJobs();
  const text =
    jobs.length === 0
      ? 'Aucune tâche en background.'
      : 'Tâches en background :\n\n' +
        jobs.map((j) => `- \`${j.jobId}\` (${j.elapsedS}s, ${j.platformId ?? '?'}) — ${j.lastAction}`).join('\n') +
        '\n\nPour annuler une tâche : `!bg-cancel N` (ex. `!bg-cancel 1`).';
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

async function handleBgCancelCommand(msg: MessageInRow, routing: RoutingContext): Promise<void> {
  const requested = parseBgCancelIds(msg);
  // No N → cancel everything. With N(s) → cancel each, report which
  // didn't exist (race: bg may have completed between msg arrival and
  // our handling).
  let cancelled = 0;
  const notFound: string[] = [];
  if (requested.length === 0) {
    cancelled = await cancelAllBackgroundJobs();
  } else {
    for (const id of requested) {
      if (await cancelBackgroundJob(id)) cancelled += 1;
      else notFound.push(id);
    }
  }
  let text: string;
  if (requested.length === 0) {
    text = cancelled > 0 ? `⏹ ${cancelled} tâche(s) background interrompue(s).` : 'Aucune tâche background à annuler.';
  } else if (notFound.length === 0) {
    text = `⏹ ${cancelled} tâche(s) interrompue(s) : ${requested.join(', ')}.`;
  } else {
    text = `⏹ ${cancelled} tâche(s) interrompue(s). Introuvable(s) : ${notFound.join(', ')}.`;
  }
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

function handleLiveCommand(routing: RoutingContext): void {
  const currentlyEnabled = getLiveEnabled();
  const next = !currentlyEnabled;
  setLiveEnabled(next);
  log(`/live toggled: ${next ? 'ON' : 'OFF'}`);
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({
      text: next
        ? "📡 Live status : **ON** — je posterai un message d'avancement qui se met à jour pendant que je travaille."
        : '🔇 Live status : **OFF** — je travaille en silence jusqu\'au message final.',
    }),
  });
}

/**
 * Per-iteration check (called from the poll heartbeat): any bg that has been
 * alive for longer than BG_MAX_DURATION_MS is auto-cancelled. Each kill
 * posts a user-facing notice so the user knows why the bg went silent.
 * Returns the number of bgs that were killed.
 */
async function reapStaleBackgroundJobs(): Promise<number> {
  if (BG_MAX_DURATION_MS <= 0) return 0;
  const now = Date.now();
  const stale: string[] = [];
  for (const [jobId, bg] of activeBackgroundQueries) {
    if (now - bg.turnStartedAt > BG_MAX_DURATION_MS) {
      stale.push(jobId);
    }
  }
  for (const jobId of stale) {
    const bg = activeBackgroundQueries.get(jobId);
    if (!bg) continue;
    activeBackgroundQueries.delete(jobId);
    bg.aborted = true; // disarm its follow-up poller
    try {
      bg.query.abort();
    } catch {
      /* swallow */
    }
    await finalizeLiveStatus(bg, { marker: 'max_duration' });
    const notice =
      `⏹ \`${jobId}\` arrêté (max duration ${Math.round(BG_MAX_DURATION_MS / 1000)}s atteinte). ` +
      `Tu peux le relancer en ré-envoyant la demande.`;
    writeMessageOut({
      id: generateId(),
      kind: 'chat',
      platform_id: bg.routing.platformId,
      channel_type: bg.routing.channelType,
      thread_id: bg.routing.threadId,
      content: JSON.stringify({ text: notice }),
    });
    log(`Auto-cancelled ${jobId} (max duration ${BG_MAX_DURATION_MS}ms)`);
  }
  return stale.length;
}

/**
 * On container startup, finalize any live-status post orphaned by a previous
 * container that died mid-turn (crash, absolute-ceiling kill, manual restart).
 * Without this, the "🔧 …" post hangs in the channel forever.
 */
function cleanupOrphanLiveStatus(): void {
  const refs = getLiveStatusPosts();
  if (refs.length === 0) return;
  for (const ref of refs) {
    const platformMsgId = ref.platformMsgId ?? getDeliveredPlatformId(ref.outboundId);
    if (platformMsgId) {
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: ref.platformId,
        channel_type: ref.channelType,
        thread_id: ref.threadId,
        content: JSON.stringify({
          operation: 'edit',
          messageId: platformMsgId,
          text: '✅ _Terminé (session précédente interrompue)_',
        }),
      });
      log(`Cleaned up orphan live-status post ${platformMsgId}`);
    }
  }
  clearLiveStatusPosts();
}

/** Push a completed bg query's result into the injection queue. */
function queueBgResult(active: ActiveQuery, result: string): void {
  pendingBgResults.push({
    jobId: active.jobId,
    originalPrompt: active.originalPrompt,
    result,
    durationMs: Date.now() - active.startedAt,
  });
  log(`Queued ${active.jobId} result (${result.length} chars) for next fg turn`);
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Reset any state from a prior runPollLoop call in the same process (only
  // happens in tests; the container runs runPollLoop exactly once). Without
  // this, the prior call's detached query promises keep writing to the new
  // outbound.db and the next test sees leaked results.
  if (activeForegroundQuery) {
    try { activeForegroundQuery.query.abort(); } catch { /* swallow */ }
  }
  for (const bg of activeBackgroundQueries.values()) {
    try { bg.query.abort(); } catch { /* swallow */ }
  }
  activeForegroundQuery = null;
  activeBackgroundQueries.clear();
  pendingBgResults.length = 0;
  freshFgContinuationNeeded = false;
  runnerProviderName = config.providerName;
  runnerStructuredDelivery = config.provider.structuredDelivery ?? false;

  // Finalize any live-status post orphaned by a previous container that died
  // mid-turn (crash, absolute-ceiling kill, manual restart) — otherwise the
  // "🔧 …" post hangs in the channel forever.
  cleanupOrphanLiveStatus();

  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;

    // Wait for the foreground slot to be free. A query can be running in the
    // background concurrently (it'll post its result independently); we just
    // need foreground availability to spawn the next user-facing query.
    if (activeForegroundQuery !== null) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // If the previous foreground was just demoted to background, force the
    // next fg to start with a fresh SDK session id. The persisted continuation
    // now belongs to the bg-N query and resuming it would race on the same
    // .jsonl transcript.
    if (freshFgContinuationNeeded) {
      continuation = undefined;
      freshFgContinuationNeeded = false;
      log('Starting next fg with fresh continuation (previous fg demoted to bg)');
    }
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending, ${activeBackgroundQueries.size} bg)`);
    }

    // Reap stale bg jobs (older than BG_MAX_DURATION_MS) — prevents a
    // stuck model (e.g. looping on a 69s IMAP timeout) from spinning
    // actions forever without the user being able to do anything about it.
    // Cheap when there are no bgs: iterates an empty map.
    if (activeBackgroundQueries.size > 0 && pollCount % 6 === 0) {
      await reapStaleBackgroundJobs();
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only commands
    // the runner handles directly are /clear (session reset) and the
    // `!`-prefixed runner commands (background, stop, live, bg-list,
    // bg-cancel, help).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if (isHelpCommand(msg)) {
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: buildHelpText() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if (isStopCommand(msg)) {
        // /stop reaching the outer loop means no foreground query is running
        // (the fg-slot gate above only lets us here when it's free). Stop any
        // background jobs and acknowledge. A /stop arriving mid-foreground is
        // caught earlier by the follow-up poller inside processQuery.
        log('/stop received in outer loop');
        const stopped = await stopAllActivity();
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({
            text: stopped > 0 ? `⏹ Arrêté — ${stopped} tâche(s) interrompue(s).` : 'Rien en cours à arrêter.',
          }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if (isBgListCommand(msg)) {
        await handleBgListCommand(routing);
        commandIds.push(msg.id);
        continue;
      }
      if (isBgCancelCommand(msg)) {
        await handleBgCancelCommand(msg, routing);
        commandIds.push(msg.id);
        continue;
      }
      if (isLiveCommand(msg)) {
        handleLiveCommand(routing);
        commandIds.push(msg.id);
        continue;
      }
      if (isBackgroundCommand(msg)) {
        // /background as the FIRST input of a batch — by the time we get here,
        // activeForegroundQuery is null (we gated above). So there's no fg to
        // demote. Friendly notice telling the user what /background does.
        // The mid-flight demotion case is handled inside processQuery's
        // follow-up poll, never here.
        log('/background received with no active foreground query (no-op)');
        const text =
          activeBackgroundQueries.size > 0
            ? `Pas de tâche foreground à basculer en background. ${activeBackgroundQueries.size} tâche(s) bg déjà en cours.`
            : `Pas de tâche foreground à basculer en background. /background s'utilise pendant qu'une tâche est en cours pour la détacher.`;
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Interactive = the turn was started by a real user message, not purely
    // by scheduled tasks. Live-status posts are suppressed for task-only
    // turns (weekly summary, daily reminder, news digest…).
    const interactive = keep.some((m) => m.kind === 'chat' || m.kind === 'chat-sdk');

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    // Prepend any completed background-job results as <background-result>
    // blocks so the agent sees what each backgrounded task produced.
    // Interactive turns only: a silent scheduled-task turn (cron summary…)
    // must not consume the queued results — the user could never act on
    // them there. They stay queued for the next real user turn.
    const userPrompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);
    const bgPreamble = interactive ? consumePendingBgResults() : '';
    const prompt = bgPreamble + userPrompt;

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));

    // Set up the ActiveQuery descriptor before spawning the consumer.
    // processQuery mutates the same descriptor on bg transition.
    const now = Date.now();
    const activeQuery: ActiveQuery = {
      jobId: 'fg',
      kind: 'foreground',
      query,
      originalPrompt: userPrompt,
      startedAt: now,
      turnStartedAt: now,
      activelyProcessing: true,
      interactive,
      routing,
      initialBatchIds: processingIds,
      live: {
        outboundId: null,
        platformMsgId: null,
        lastUpdateAt: 0,
        latestText: '',
        eventCount: 0,
      },
    };
    activeForegroundQuery = activeQuery;

    // Spawn processQuery as detached promise — DO NOT await. The outer loop
    // top guards on activeForegroundQuery !== null. If processQuery transitions
    // this query to bg mid-flight, it sets activeForegroundQuery = null
    // (freeing the slot) and moves the descriptor to activeBackgroundQueries.
    void (async () => {
      // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
      // can stamp it on outbound rows — needed for a2a return-path routing.
      // NB: with multiple concurrent queries this is shared across them; if
      // a bg query needs to use send_message we may need to scope this per-
      // query. For now both queries should be safe because send_message is
      // synchronous within an SDK turn.
      setCurrentInReplyTo(routing.inReplyTo);
      try {
        const result = await processQuery(
          activeQuery,
          config.providerName,
          config.provider.onExchangeComplete?.bind(config.provider),
        );
        // Only persist continuation when the query completed as foreground.
        // Backgrounded queries deliberately leak their continuation so the
        // foreground next-turn keeps a clean continuation (the bg result was
        // already injected as context).
        if (
          activeQuery.kind === 'foreground' &&
          result.continuation &&
          result.continuation !== continuation
        ) {
          continuation = result.continuation;
          setContinuation(config.providerName, continuation);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Query error: ${errMsg}`);

        // Only a FOREGROUND query may clear the shared continuation: a bg
        // job dying with a session-invalid error would otherwise wipe the
        // current foreground conversation's memory (its own continuation was
        // already detached at demotion — see transitionToBackground).
        if (activeQuery.kind === 'foreground' && continuation && config.provider.isSessionInvalid(err)) {
          log(`Stale session detected (${continuation}) — clearing for next retry`);
          continuation = undefined;
          clearContinuation(config.providerName);
        }

        // Clean up the live-status post (if any) before posting the error so
        // the user doesn't see a stale "🔧 working" indicator next to the
        // error message.
        await finalizeLiveStatus(activeQuery);

        const tag = activeQuery.kind === 'background' ? `\`${activeQuery.jobId}\` ` : '';
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: `${tag}Error: ${errMsg}` }),
        });
      } finally {
        // Only clear the shared inReplyTo if it's still OURS — a background
        // job completing mid-foreground-turn must not null the value the
        // current fg's send_message/send_file tools stamp on outbound rows
        // (a2a return-path routing would lose the correlation).
        if (getCurrentInReplyTo() === routing.inReplyTo) {
          clearCurrentInReplyTo();
        }
        markCompleted(processingIds);
        // Slot bookkeeping: free fg slot or remove from bg map.
        if (activeForegroundQuery === activeQuery) activeForegroundQuery = null;
        activeBackgroundQueries.delete(activeQuery.jobId);
        log(`Completed ${activeQuery.kind === 'background' ? activeQuery.jobId : ids.length + ' message(s)'}`);
      }
    })();
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

export async function processQuery(
  active: ActiveQuery,
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
): Promise<QueryResult> {
  const { query, routing, initialBatchIds, originalPrompt } = active;
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [originalPrompt];

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    // `active.aborted`: the query was stopped (!stop / !bg-cancel / reap) but
    // the SDK abort is soft — until the next event unwinds the for-await,
    // this poller would otherwise keep claiming messages for a dead stream.
    if (done || pollInFlight || endedForCommand || active.aborted) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // /stop mid-stream: abort EVERYTHING (this fg query + all bg jobs),
        // finalize every live-status post to "⏹ Arrêté", acknowledge. Checked
        // before /background and before the generic isRunnerCommand bail so it
        // is handled by the runner, not passed through to the SDK.
        const stopMsgs = pending.filter((m) => isStopCommand(m));
        if (stopMsgs.length > 0) {
          markCompleted(stopMsgs.map((m) => m.id));
          log('/stop received mid-foreground — aborting all activity');
          const stopped = await stopAllActivity();
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: `⏹ Arrêté — ${stopped} tâche(s) interrompue(s).` }),
          });
          return; // this query was aborted by stopAllActivity; its for-await will end
        }

        // /background mid-stream: demote current query and release the follow-
        // up messages so the outer loop picks them up as a fresh foreground.
        // We don't push anything into the bg query; it continues its current
        // turn and posts the result with [bg-N] tag when done.
        // Only meaningful if the agent is actively processing — backgrounding
        // an idle session is a no-op (post a friendly notice instead).
        const bgCommandMsgs = pending.filter((m) => isBackgroundCommand(m));
        if (bgCommandMsgs.length > 0 && active.kind === 'foreground') {
          markCompleted(bgCommandMsgs.map((m) => m.id));
          if (active.activelyProcessing) {
            transitionToBackground('manual', active);
          } else {
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({
                text: "Pas de tâche en cours à basculer en background (j'avais déjà fini ma réponse précédente).",
              }),
            });
          }
          return;
        }

        // Read-only / bg-control commands (!help, !bg-list, !bg-cancel,
        // !live): handled INLINE — consulting the bg list or cancelling a
        // background job must never abort the in-flight foreground turn.
        const inlineMsgs = pending.filter(
          (m) => isHelpCommand(m) || isBgListCommand(m) || isBgCancelCommand(m) || isLiveCommand(m),
        );
        if (inlineMsgs.length > 0) {
          markCompleted(inlineMsgs.map((m) => m.id));
          for (const m of inlineMsgs) {
            if (isHelpCommand(m)) {
              writeMessageOut({
                id: generateId(),
                kind: 'chat',
                platform_id: routing.platformId,
                channel_type: routing.channelType,
                thread_id: routing.threadId,
                content: JSON.stringify({ text: buildHelpText() }),
              });
            } else if (isBgListCommand(m)) {
              await handleBgListCommand(routing);
            } else if (isBgCancelCommand(m)) {
              await handleBgCancelCommand(m, routing);
            } else if (isLiveCommand(m)) {
              handleLiveCommand(routing);
            }
          }
          // Fall through: other pending messages (if any) still get the
          // normal treatment below on this same tick.
        }

        // Commands that need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        //
        // Scope: admin-category commands (any prefix) and `/`-prefixed
        // passthrough (real SDK slash commands). `!`-prefixed passthrough is
        // ordinary text ("!important note" …) — Mattermost users would lose
        // their in-flight turn over a message that isn't a command at all.
        const needsFreshQuery = (m: MessageInRow): boolean => {
          if (m.kind !== 'chat' && m.kind !== 'chat-sdk') return false;
          const info = categorizeMessage(m);
          if (info.category === 'admin') return true;
          return info.category === 'passthrough' && info.text.trimStart().startsWith('/');
        };
        if (pending.some((m) => needsFreshQuery(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses) and the inline-handled
        // commands above (already markCompleted — they must not be pushed
        // into the query as text).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const inlineIds = new Set(inlineMsgs.map((m) => m.id));
        const newMessages = pending.filter((m) => m.kind !== 'system' && !inlineIds.has(m.id));
        if (newMessages.length === 0) return;

        // Smart auto-bg: only fires when ALL of these hold:
        //   - threshold > 0 (env override `NANOCLAW_AUTO_BG_THRESHOLD_MS=0` disables)
        //   - still a foreground query
        //   - new message is user-visible (chat — not a cron-task or system)
        //   - the agent is *actively processing* the current turn (NOT idle
        //     between turns; backgrounding an idle session is meaningless and
        //     produces a confusing "Cette tâche prend du temps" notice when
        //     the agent had actually finished its reply seconds ago)
        //   - the CURRENT TURN has been running > threshold (turnStartedAt
        //     resets on push, NOT query startedAt — long-lived sessions with
        //     fast turns must never trigger auto-bg)
        const userVisible = newMessages.some((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
        if (
          AUTO_BG_THRESHOLD_MS > 0 &&
          active.kind === 'foreground' &&
          userVisible &&
          active.activelyProcessing &&
          Date.now() - active.turnStartedAt > AUTO_BG_THRESHOLD_MS
        ) {
          transitionToBackground('auto', active);
          // Release the new messages back to pending so the next fg can pick
          // them up rather than being consumed by a now-bg'd query.
          releaseProcessing(newMessages.map((m) => m.id));
          return;
        }

        // Background queries don't accept follow-ups — release any new messages
        // back to pending. The outer loop will pick them up as a fresh fg.
        if (active.kind === 'background') {
          releaseProcessing(newMessages.map((m) => m.id));
          return;
        }

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done/aborted — the outer query may have finished (or been
        // stopped) while the script was awaited. Pushing into a closed or
        // aborted stream silently swallows the messages: push-after-end is
        // never consumed but markCompleted below would still run. Release
        // the claim so the outer loop picks them up as a fresh foreground.
        if (done || active.aborted) {
          releaseProcessing(keep.map((m) => m.id));
          return;
        }

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        // Reset the turn clock and resume keepalive — the next event stream
        // starts a fresh turn. Auto-bg gates on (turnStartedAt, activelyProcessing).
        active.turnStartedAt = Date.now();
        active.activelyProcessing = true;
        query.push(prompt);
        archivePrompts.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  // Heartbeat keepalive: touch the heartbeat file every 4s regardless of
  // SDK events. Long MCP tool calls (e.g. Gmail listing many emails) produce
  // no intermediate events, so the event-driven touchHeartbeat() in the
  // for-await loop goes silent — the host's 6s HEARTBEAT_FRESH_MS threshold
  // then marks the container idle and stops the typing indicator. This timer
  // ensures the host always sees a fresh heartbeat during active queries.
  // Only touch while actively generating — not while idle between turns.
  // activelyProcessing goes false on `result` and back to true when a
  // follow-up is pushed, so the typing indicator clears between turns.
  const heartbeatKeepalive = setInterval(() => {
    if (!done && active.activelyProcessing) touchHeartbeat();
  }, 4_000);

  // Live-status refresh: when no new tool-call event for a while (long IMAP
  // search, slow thinking step, big Bash command), the status post in the
  // channel keeps its stale text and elapsed-time counter, looking frozen
  // from the user's POV. Periodically re-call updateLiveStatus with the last
  // known text so the rendered `Xs` counter advances. The throttle inside
  // updateLiveStatus (LIVE_STATUS_THROTTLE_MS) prevents over-updating when
  // events are also flowing fast.
  const liveStatusRefresh = setInterval(() => {
    if (done || !active.activelyProcessing) return;
    if (active.live.outboundId && active.live.latestText) {
      // countAction: false — a refresh re-render is not a new tool action.
      updateLiveStatus(active, active.live.latestText, { countAction: false });
    }
  }, 3_000);

  // Idle-event watchdog: if the SDK stops producing events for too long,
  // assume it's stuck and force-abort. The for-await loop will exit (the
  // SDK either yields the abort error or just closes the iterator), the
  // finally block runs, and the outer poll-loop is free to spawn a fresh
  // query for any pending messages. Without this, a hung SDK after a
  // `result` blocks all future messages for this session for 30 min
  // (until host-sweep ABSOLUTE_CEILING_MS kills the container).
  let lastEventAt = Date.now();
  const idleWatchdog = setInterval(() => {
    if (done) return;
    const idleMs = Date.now() - lastEventAt;
    if (idleMs > QUERY_IDLE_TIMEOUT_MS) {
      log(`Query idle for ${Math.round(idleMs / 1000)}s — aborting (likely SDK hang post-result)`);
      try {
        query.abort();
      } catch {
        /* swallow; if abort itself throws we'll still exit via the iterator close */
      }
    }
  }, 30_000);

  try {
    for await (const event of query.events) {
      lastEventAt = Date.now();
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'progress') {
        updateLiveStatus(active, event.message);
      }

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately ONLY when the query is foreground — bg queries
        // deliberately don't write the continuation so they don't pollute the
        // foreground's resume point. The bg's continuation is dropped when
        // its consumer finishes; its result is preserved via the injection
        // mechanism (pendingBgResults).
        if (active.kind === 'foreground') {
          setContinuation(providerName, event.continuation);
        }
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        active.activelyProcessing = false; // pause heartbeat keepalive AND gate auto-bg until next push
        // Finalize the live-status post (edit → "✅ Terminé") before the final
        // message gets dispatched so the user sees: status post → done marker,
        // final answer → appears. Order matters for clean UX.
        await finalizeLiveStatus(active);
        markCompleted(initialBatchIds);
        if (event.text) {
          // BG path: tag the result with the bg job id so the user can tell it
          // apart from regular foreground messages, then end the query (bg
          // queries are single-turn, no follow-ups).
          if (active.kind === 'background') {
            // Tag each delivered message with the bg job id so the user can tell
            // it apart from foreground replies. dispatchResultText applies the
            // tag for both delivery styles (envelope blocks or structured reply).
            const { sent, hasUnwrapped } = dispatchResultText(event.text, routing, `\`${active.jobId}\` `);
            if (sent === 0 && event.isError === true) {
              deliverErrorResult(event.text, routing);
            }
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? originalPrompt,
              result: event.text,
              continuation: queryContinuation,
              status: event.isError ? 'error' : hasUnwrapped ? 'undelivered' : 'completed',
            });
            archivePrompts.shift();
            queueBgResult(active, event.text);
            query.end();
            break; // exit for-await; the finally + final return handle cleanup
          }
          const { sent, hasUnwrapped } = dispatchResultText(event.text, routing);
          if (sent === 0 && event.isError === true) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? originalPrompt,
              result: event.text,
              continuation: queryContinuation,
              status: 'error',
            });
            archivePrompts.shift();
          } else {
            const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? originalPrompt,
              result: event.text,
              continuation: queryContinuation,
              status: hasUnwrapped ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              // Nudge restarts a new turn — reset turn clock + resume keepalive.
              active.turnStartedAt = Date.now();
              active.activelyProcessing = true;
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
            // The wrapping-retry result answers the SAME user prompt — keep it
            // queued so the retry archives against it, not the nudge text.
            if (!willRetryWrapping) archivePrompts.shift();
          }
        } else if (active.kind === 'background') {
          // Empty bg result — still queue + end.
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? originalPrompt,
            result: '',
            continuation: queryContinuation,
            status: 'completed',
          });
          archivePrompts.shift();
          queueBgResult(active, '(empty)');
          query.end();
          break;
        } else {
          // Empty fg result — notify and advance the prompt queue.
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? originalPrompt,
            result: '',
            continuation: queryContinuation,
            status: 'completed',
          });
          archivePrompts.shift();
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? originalPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    clearInterval(idleWatchdog);
    clearInterval(heartbeatKeepalive);
    clearInterval(liveStatusRefresh);
  }

  return { continuation: queryContinuation };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
/** Deliver one chat message to the session's origin destination (the channel +
 * thread this turn is replying in). Used by the structured-delivery path and the
 * error fallback. No envelope, no regex — the text is delivered as-is. */
function deliverToOrigin(text: string, routing: RoutingContext): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

function deliverErrorResult(text: string, routing: RoutingContext): void {
  log('Error result with no <message> envelope — delivering to channel');
  deliverToOrigin(text, routing);
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(
  rawText: string,
  routing: RoutingContext,
  bgTag = '',
): { sent: number; hasUnwrapped: boolean } {
  // Structured-delivery providers (e.g. Claude): routing comes from the
  // structured `send_message` tool, and the final result text is the reply to
  // the conversation this turn is in. Sanitize it (drop any leaked tool-call
  // markup + habitual <internal>/<message> tags) and deliver as-is to the
  // origin — we never regex-parse free text for routing, so no markup fragment
  // can bleed into a parsed reply. Empty after sanitizing → pure scratchpad.
  if (runnerStructuredDelivery) {
    const clean = stripEnvelopeTags(stripToolMarkup(stripInternalTags(rawText))).trim();
    if (!clean) return { sent: 0, hasUnwrapped: false };
    deliverToOrigin(bgTag + clean, routing);
    return { sent: 1, hasUnwrapped: false };
  }

  // Legacy text-envelope path: regex-parse <message to="…"> blocks.
  // Strip any orphan tool-call markup the model leaked first (defense-in-depth).
  let text = stripToolMarkup(rawText);
  // Background jobs prefix each delivered block with their `bg-N` id.
  if (bgTag) {
    text = text.replace(/<message(\s+to="[^"]+")\s*>/g, (_m, attrs) => `<message${attrs}>${bgTag}`);
  }
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

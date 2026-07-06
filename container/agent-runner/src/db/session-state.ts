/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

const LIVE_ENABLED_KEY = 'live_enabled';

/**
 * Read the live-status toggle for this session. Default true — when the
 * value has never been set, treat as enabled. Persisted in outbound.db's
 * session_state so toggling survives container restarts.
 */
export function getLiveEnabled(): boolean {
  const v = getValue(LIVE_ENABLED_KEY);
  return v === undefined ? true : v === 'true';
}

export function setLiveEnabled(enabled: boolean): void {
  setValue(LIVE_ENABLED_KEY, enabled ? 'true' : 'false');
}

const LIVE_POST_KEY = 'live_status_post';

/**
 * Reference to the live-status post currently being maintained, persisted so
 * that if the container dies mid-turn (crash, absolute-ceiling kill, manual
 * restart) the NEXT container can find the orphaned "🔧 …" post and finalize
 * it (edit to a done marker) instead of leaving it dangling forever.
 *
 * `outboundId` is our generated message id (always known at create time);
 * `platformMsgId` is the channel post id, known only once the host has
 * delivered the create. Startup cleanup resolves the latter from the
 * `delivered` table if it's still null here.
 */
export interface LiveStatusPostRef {
  outboundId: string;
  platformMsgId: string | null;
  /** platform_id + channel_type + thread_id needed to address the edit. */
  platformId: string;
  channelType: string;
  threadId: string | null;
}

/**
 * The persisted value is a MAP keyed by outboundId — fg and bg queries can
 * each maintain their own live post concurrently, and a single-slot value
 * meant one query's finalize wiped the other's ref (its orphaned "🔧 …"
 * post could then never be cleaned up after a crash).
 */
function readLivePostMap(): Record<string, LiveStatusPostRef> {
  const v = getValue(LIVE_POST_KEY);
  if (!v) return {};
  try {
    const parsed = JSON.parse(v) as Record<string, LiveStatusPostRef> | LiveStatusPostRef;
    // Legacy single-object shape (pre multi-slot): migrate on read.
    if (typeof parsed === 'object' && parsed !== null && 'outboundId' in parsed) {
      const ref = parsed as LiveStatusPostRef;
      return { [ref.outboundId]: ref };
    }
    return parsed as Record<string, LiveStatusPostRef>;
  } catch {
    return {};
  }
}

export function addLiveStatusPost(ref: LiveStatusPostRef): void {
  const map = readLivePostMap();
  map[ref.outboundId] = ref;
  setValue(LIVE_POST_KEY, JSON.stringify(map));
}

export function getLiveStatusPosts(): LiveStatusPostRef[] {
  return Object.values(readLivePostMap());
}

export function removeLiveStatusPost(outboundId: string): void {
  const map = readLivePostMap();
  if (!(outboundId in map)) return;
  delete map[outboundId];
  if (Object.keys(map).length === 0) {
    deleteValue(LIVE_POST_KEY);
  } else {
    setValue(LIVE_POST_KEY, JSON.stringify(map));
  }
}

export function clearLiveStatusPosts(): void {
  deleteValue(LIVE_POST_KEY);
}

const BG_JOBS_KEY = 'bg_jobs';

/**
 * Snapshot of the running background jobs, persisted for OBSERVABILITY only
 * (the host dashboard pusher reads outbound.db and surfaces it). The
 * authoritative state stays in the poll-loop's in-memory map — on container
 * death the jobs are gone (by design), so runPollLoop clears this key at
 * startup rather than trying to resume anything from it.
 */
export interface BgJobSnapshot {
  jobId: string;
  /** turnStartedAt of the query — what the user perceives as job start. */
  startedAt: number;
  /** live-status event count ("N actions"). */
  actions: number;
  /** latest live-status one-liner (e.g. "🔧 imap_search_emails(…)"). */
  lastAction: string;
  /** original prompt, truncated by the writer. */
  prompt: string;
}

export function setBgJobsSnapshot(jobs: BgJobSnapshot[]): void {
  if (jobs.length === 0) deleteValue(BG_JOBS_KEY);
  else setValue(BG_JOBS_KEY, JSON.stringify(jobs));
}

export function getBgJobsSnapshot(): BgJobSnapshot[] {
  const v = getValue(BG_JOBS_KEY);
  if (!v) return [];
  try {
    return JSON.parse(v) as BgJobSnapshot[];
  } catch {
    return [];
  }
}

/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in outbound.db rather than module state because the MCP server
 * runs as a separate stdio subprocess from the poll loop — module state set
 * by the poll loop is invisible to it. Both processes open outbound.db
 * (journal_mode=DELETE + busy_timeout make intra-container access safe).
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getOutboundDb()
    .prepare('SELECT value, updated_at FROM session_state WHERE key = ?')
    .get(IN_REPLY_TO_KEY) as { value: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}

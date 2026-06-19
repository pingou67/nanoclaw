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

export function setLiveStatusPost(ref: LiveStatusPostRef): void {
  setValue(LIVE_POST_KEY, JSON.stringify(ref));
}

export function getLiveStatusPost(): LiveStatusPostRef | undefined {
  const v = getValue(LIVE_POST_KEY);
  if (!v) return undefined;
  try {
    return JSON.parse(v) as LiveStatusPostRef;
  } catch {
    return undefined;
  }
}

export function clearLiveStatusPost(): void {
  deleteValue(LIVE_POST_KEY);
}

import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/' or '!'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 *
 * Note: in Mattermost, any message starting with `/` is a candidate for
 * Mattermost's own slash-command parser and is often dropped before the bot
 * ever sees it ("command not found" in the UI, never posted). The `!`-form
 * is the only form that's actually reachable in practice. We accept both
 * for the categorization because (a) some channels reach the bot via
 * non-Mattermost adapters (chat-sdk, webhooks) that DO pass `/`-prefixed
 * text through, and (b) the integration test suite relies on the `/`-form
 * for `isRunnerCommand` to detect mid-stream follow-ups.
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

// Stored WITHOUT the prefix so a single set covers both `/` and `!` forms.
// The `command` field returned by categorizeMessage is the prefix-restored
// form (e.g. '/clear' or '!clear') for downstream logging.
const ADMIN_COMMANDS = new Set(['remote-control', 'clear', 'compact', 'context', 'cost', 'files', 'upload-trace']);
const FILTERED_COMMANDS = new Set(['login', 'logout', 'doctor', 'config', 'start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear' or '!clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/') && !text.startsWith('!')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args').
  // Strip the leading `/` or `!` prefix for the lookup; re-attach it in
  // the returned `command` field for logging consistency.
  const raw = text.split(/\s/)[0];
  const prefix = raw[0] as '/' | '!';
  const name = raw.slice(1).toLowerCase();
  const command = `${prefix}${name}`;

  if (ADMIN_COMMANDS.has(name)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(name)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 *
 * All runner commands also accept a `!` prefix (`!clear`, `!stop`, …):
 * Mattermost swallows any message starting with `/` as one of its own slash
 * commands ("command not found", never posted), so the `/` forms are
 * untypeable there. The `!` forms pass through as regular posts.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  // `!`-prefix only — Mattermost intercepts every `/`-command before the bot
  // can see it, so the `/clear` form was always unreachable in practice.
  // Exact match: `!clearly …` or `!clear-cache` must NOT wipe the session.
  return text === '!clear';
}

/**
 * Check for `!background` — runner-handled command that demotes the currently
 * active foreground query to a background job, freeing the foreground slot
 * for new user messages. The bg job's eventual result is posted with a
 * `[bg-N]` tag AND injected as context into the next foreground turn.
 *
 * Form: a standalone `!background` (or `!bg`) message that arrives while a
 * foreground query is in flight. Sending `!background` with no active query
 * is a no-op (a friendly notice is posted).
 */
export function isBackgroundCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  return text === '!background' || text === '!bg';
}

/**
 * Check for `!live` — runner-handled command that toggles the live-status-post
 * feature on/off for this session. When ON, the agent maintains a single
 * status post in the channel (created on first tool/progress event of a turn,
 * edited as the agent works, deleted on turn completion). Default ON.
 */
export function isLiveCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  return text === '!live';
}

/**
 * Check for `!stop` — runner-handled command that aborts ALL in-flight Claude
 * activity for this session (the foreground query AND every background job),
 * finalizes their live-status posts, and clears pending bg results. Unlike
 * `!clear` it does NOT wipe the conversation continuation — the next message
 * resumes normally. Standalone message only.
 */
export function isStopCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  return text === '!stop';
}

/**
 * Check for `!bg-list` — runner-handled command that lists the running
 * background jobs with their id, elapsed time, and last tool action. Useful
 * before deciding which one to cancel. Standalone message only.
 *
 * Note: `!`-prefix to avoid Mattermost intercepting `/` (every slash command
 * starting a line is a Mattermost built-in candidate).
 */
export function isBgListCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  return text === '!bg-list' || text === '!bglist' || text === '!bg list';
}

/**
 * Check for `!help` — runner-handled command that lists every available
 * `!`-command with a one-line description and an example. Useful as a
 * reminder of what's possible, especially after Mattermost intercepts the
 * `/`-form of every command.
 */
export function isHelpCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  return text === '!help' || text === '!aide';
}

/**
 * Build the help message posted in response to `!help`. Markdown formatted
 * for Mattermost. Kept in one place so adding a new command only touches
 * this string (and the detection fn), not the poll-loop handler.
 */
export function buildHelpText(): string {
  return [
    '🤖 **Commandes Hal** (toutes préfixées par `!` — Mattermost intercepte les `/`)',
    '',
    '**Contrôle de l\'agent**',
    '• `!help` (alias `!aide`) — afficher cette aide',
    '• `!background` (alias `!bg`) — basculer la tâche foreground en background (continue à tourner, libère la main)',
    '• `!stop` — arrêter **toutes** les tâches (foreground + background)',
    '• `!live` — toggle l\'affichage du statut en direct dans le channel',
    '',
    '**Gestion des background jobs**',
    '• `!bg-list` — lister les bg en cours (id, durée, dernière action)',
    '• `!bg-cancel N` — annuler le bg-N spécifiquement (ex. `!bg-cancel 1`)',
    '• `!bg-cancel` (sans N) — annuler **tous** les bg (fg intouché)',
    '',
    '**Contexte**',
    '• `!clear` — effacer la mémoire de conversation (la prochaine msg repart de zéro)',
    '',
    '**Exemples rapides**',
    '• Tu attends un bg depuis 5 min et tu ne sais pas ce qu\'il fait : `!bg-list`',
    '• Un bg est stuck (boucle sur un timeout) : `!bg-cancel 1` puis relance la demande',
    '• Tu veux tout couper et reprendre fresh : `!stop`',
    '• Le status en direct te saoule : `!live` (toggle, re-toggle pour réactiver)',
    '',
    '_Note : les commandes sont détectées uniquement sur messages standalone (pas mid-texte). Pour les commandes admin Claude Code natives (`/compact`, `/cost`, etc.) : `!clear` couvre le cas le plus courant._',
  ].join('\n');
}

/**
 * Check for `!bg-cancel [N]` — runner-handled command that aborts one or all
 * background jobs. With no N, cancels every bg (the fg is untouched). With
 * N (e.g. `!bg-cancel 2`), cancels only that bg job. Does not affect the
 * foreground query. Standalone message only.
 */
export function isBgCancelCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  return text === '!bg-cancel' || text === '!bgcancel' || text === '!bg cancel'
      || /^!bg[- ]?cancel\s+\d+(\s+\d+)*$/.test(text);
}

/**
 * Parse the bg job ids from a `!bg-cancel N [M ...]` message. Returns an
 * empty array for `!bg-cancel` alone (meaning "cancel all"). Filters out
 * non-numeric tokens defensively even though the regex guards the entry.
 */
export function parseBgCancelIds(msg: MessageInRow): string[] {
  if (!isBgCancelCommand(msg)) return [];
  const content = parseContent(msg.content);
  const text = (content.text || '').trim().toLowerCase();
  const tokens = text.split(/\s+/);
  const ids: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) ids.push(`bg-${t}`);
  }
  return ids;
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg).category;
  return cat === 'admin' || cat === 'passthrough';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  /** Batch is a task run. One-door delivery: only an explicitly addressed tool
   *  delivers from a task session; final-text `<message to>` blocks are inert
   *  and the final text auto-appends to the series run log. */
  taskRun: boolean;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
    taskRun: messages.length > 0 && messages.every((m) => m.kind === 'task'),
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  // Each `<message id="..." from="...">...</message>` block is self-contained;
  // concatenating them reads to the agent as a sequence of distinct messages.
  // Earlier revisions wrapped multi-message batches in an outer `<messages>`
  // envelope, but the Claude Agent SDK responded to that shape with a
  // synthetic stub (`model: "<synthetic>"`, `content: "No response
  // requested."`) instead of calling the API — see #2555 for the full trace.
  // The fix is simply to drop the wrapper; the single-message path (which
  // already worked) is now just the N=1 case of the same code.
  return messages.map(formatSingleChat).join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  const fromAttr = originAttr(msg);

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

/**
 * Build a ` from="destination_name"` attribute string from a message's routing
 * fields. Shared by all formatters so the agent always knows where a message
 * originated — critical for explicit addressing.
 */
function originAttr(msg: MessageInRow): string {
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const parts: string[] = [];
  if (content.scriptOutput) {
    parts.push('Script output:', JSON.stringify(content.scriptOutput, null, 2), '');
  }
  parts.push('Instructions:', stripLegacyTaskContract(content.prompt || ''));
  return `<task${from} time="${escapeXml(time)}">${parts.join('\n')}</task>`;
}

const LEGACY_TASK_CONTRACT_MARKERS = [
  '\n\n[A task serves the user two separate ways —',
  '\n\n[Task delivery contract:',
];

/**
 * PR #2981 persisted its generated delivery contract inside each task prompt.
 * New sessions receive the contract from their runtime system prompt instead.
 * Strip only a known generated suffix, at read time, so existing task rows stay
 * compatible without a session-DB migration or contradictory model guidance.
 */
export function stripLegacyTaskContract(prompt: string): string {
  if (!prompt.trimEnd().endsWith(']')) return prompt;

  let contractStart = -1;
  for (const marker of LEGACY_TASK_CONTRACT_MARKERS) {
    contractStart = Math.max(contractStart, prompt.lastIndexOf(marker));
  }
  return contractStart >= 0 ? prompt.slice(0, contractStart).trimEnd() : prompt;
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  const from = originAttr(msg);
  return `<webhook${from} source="${escapeXml(source)}" event="${escapeXml(event)}">${JSON.stringify(content.payload || content, null, 2)}</webhook>`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  return `<system_response${from} action="${escapeXml(content.action || 'unknown')}" status="${escapeXml(content.status || 'unknown')}">${JSON.stringify(content.result || null)}</system_response>`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Strip orphan tool-call markup that some models (notably Opus 4.x) occasionally
 * leak into their final text — e.g. a stray `</parameter>` left at the end of a
 * reply, or a partial `<invoke …>` / `<function_calls>` fragment. These tags are
 * never legitimate prose, so removing them is safe. Defense-in-depth against the
 * SDK passing a malformed tool-call fragment through in `result`.
 *
 * Observed 2026-06-28 on #dm: a web-search answer was delivered with a trailing
 * `</parameter>` after the model's tool block bled into the response text.
 */
export function stripToolMarkup(text: string): string {
  return applyOutsideCodeFences(text, (seg) =>
    seg.replace(/<\/?(?:antml:)?(?:function_calls|invoke|parameter)(?:\s[^>]*)?\/?>/gi, ''),
  );
}

/**
 * Apply `transform` only to the segments of `text` OUTSIDE fenced code
 * blocks (``` … ```). The strip helpers run on every final reply — without
 * this, an answer legitimately QUOTING tool-call XML or `<message>` examples
 * in a code block would have its tags silently deleted, leaving gibberish.
 * An unterminated fence leaves the trailing segment treated as prose.
 */
function applyOutsideCodeFences(text: string, transform: (segment: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```)/);
  return parts.map((p, i) => (i % 2 === 1 ? p : transform(p))).join('');
}

/**
 * Remove `<message …>` / `</message>` envelope *tags* while keeping their inner
 * content. Used only on the structured-delivery path (see AgentProvider
 * `structuredDelivery`): routing there comes from the structured `send_message`
 * tool, not from parsing these tags — so if a model wraps its origin reply in an
 * envelope out of habit, we degrade it to plain text rather than shipping the
 * literal tags. This drops tags, it does NOT parse them for routing.
 */
export function stripEnvelopeTags(text: string): string {
  return applyOutsideCodeFences(text, (seg) => seg.replace(/<\/?message(?:\s[^>]*)?>/gi, ''));
}

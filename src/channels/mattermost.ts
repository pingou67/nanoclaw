/**
 * Mattermost channel adapter (native, in-process).
 *
 * Replaces the standalone `container/mattermost-bot/` Docker bots. Lives
 * inside the main NanoClaw process so it benefits from v2's session DB,
 * container reuse, delivery polls, scheduling, and OneCLI infra.
 *
 * Config is read from `data/mattermost.json`:
 *
 *   {
 *     "url": "https://mm.pegs.fr",
 *     "token": "<bot token>",
 *     "channels": [
 *       { "channel": "main",     "folder": "mattermost_main",     "requireMention": true  },
 *       { "channel": "work",     "folder": "mattermost_work",     "requireMention": false },
 *       ...
 *       { "isDM": true,          "folder": "mattermost_dm",       "requireMention": false }
 *     ]
 *   }
 *
 * Each non-DM channel registers a `messaging_groups` row with platform_id
 * `mm:<folder>` and wires it to an `agent_groups` row with the matching
 * folder. DMs lazily auto-create messaging_groups on first inbound event
 * (one mg per DM channel).
 *
 * `supportsThreads = false`: Mattermost has root_id threads but they are
 * sub-conversations within a channel, so we collapse to one session per
 * channel and propagate the originating root_id back via a per-mg pending
 * map so replies land in the same thread.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from '../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { log } from '../log.js';
import { insertTask } from '../modules/scheduling/db.js';
import { openInboundDb, resolveSession } from '../session-manager.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

interface ChannelConfig {
  /** Mattermost channel name (e.g. "main"). Required unless isDM. */
  channel?: string;
  /** v2 agent_groups folder name (e.g. "mattermost_main"). Required. */
  folder: string;
  /** If true, requires @<bot_username> mention to engage; otherwise responds to all messages. */
  requireMention: boolean;
  /** If true, this entry handles DMs; channel name not needed. */
  isDM?: boolean;
}

interface MattermostConfig {
  url: string;
  token: string;
  channels: ChannelConfig[];
}

interface BotIdentity {
  id: string;
  username: string;
}

interface MmPost {
  id: string;
  user_id: string;
  channel_id: string;
  message: string;
  type?: string;
  root_id?: string;
  file_ids?: string[];
  create_at?: number;
}

interface MmFileInfo {
  id: string;
  name: string;
  mime_type?: string;
  mimeType?: string;
  size?: number;
}

const PLATFORM_PREFIX = 'mm:';

/**
 * Office formats that Claude can't ingest natively. Converted to PDF
 * via libreoffice on the host before being passed to the agent — the
 * Claude API supports PDF document blocks natively.
 */
const OFFICE_EXTS = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

/**
 * Convert an office document to PDF using libreoffice on the host.
 * Returns null if libreoffice is missing or the conversion fails — the
 * caller falls back to passing the original file through unchanged.
 *
 * Uses an isolated `--user-profile` per call so concurrent conversions
 * don't trip on each other (libreoffice locks its profile dir by default).
 */
async function convertOfficeToPdf(
  input: Buffer,
  originalName: string,
): Promise<{ name: string; mimeType: string; data: Buffer } | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-office-'));
  const profileDir = path.join(tmpDir, 'profile');
  // The filename is uploader-controlled (echoed by /files/<id>/info) — a name
  // like `../../x.docx` would otherwise be a host-side path-traversal write.
  const base = path.basename(originalName).replace(/[\\/]/g, '_');
  const safeName = base === '' || base === '.' || base === '..' ? `document${path.extname(originalName)}` : base;
  const inputPath = path.join(tmpDir, safeName);
  fs.writeFileSync(inputPath, input);

  try {
    await execFileAsync(
      'libreoffice',
      [
        `-env:UserInstallation=file://${profileDir}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        tmpDir,
        inputPath,
      ],
      { timeout: 60_000 },
    );
    const pdfName = safeName.replace(/\.[^.]+$/, '.pdf');
    const pdfPath = path.join(tmpDir, pdfName);
    if (!fs.existsSync(pdfPath)) {
      log.warn('Mattermost: libreoffice produced no PDF', { originalName });
      return null;
    }
    const data = fs.readFileSync(pdfPath);
    log.info('Mattermost: converted office attachment to PDF', {
      originalName,
      pdfName,
      sizeIn: input.length,
      sizeOut: data.length,
    });
    return { name: pdfName, mimeType: 'application/pdf', data };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      log.warn(
        'Mattermost: libreoffice not installed — office attachment passed through unchanged. Install with: sudo apt install libreoffice',
        { originalName },
      );
    } else {
      log.warn('Mattermost: libreoffice conversion failed', { originalName, err: msg });
    }
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function loadConfig(): MattermostConfig | null {
  const file = path.join(DATA_DIR, 'mattermost.json');
  if (!fs.existsSync(file)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as MattermostConfig;
    if (!cfg.url || !cfg.token || !Array.isArray(cfg.channels)) {
      log.warn('Mattermost: malformed mattermost.json (missing url/token/channels)');
      return null;
    }
    return cfg;
  } catch (err) {
    log.warn('Mattermost: failed to parse mattermost.json', { err: (err as Error).message });
    return null;
  }
}

function platformIdFor(folder: string, dmChannelId?: string): string {
  return dmChannelId ? `${PLATFORM_PREFIX}${folder}:${dmChannelId}` : `${PLATFORM_PREFIX}${folder}`;
}

function parsePlatformId(platformId: string): { folder: string; dmChannelId?: string } | null {
  if (!platformId.startsWith(PLATFORM_PREFIX)) return null;
  const rest = platformId.slice(PLATFORM_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length === 1) return { folder: parts[0] };
  if (parts.length === 2) return { folder: parts[0], dmChannelId: parts[1] };
  return null;
}

function createAdapter(): ChannelAdapter | null {
  const cfg = loadConfig();
  if (!cfg) {
    log.info('Mattermost: no config (data/mattermost.json missing) — skipping');
    return null;
  }

  let ws: WebSocket | null = null;
  let me: BotIdentity | null = null;
  let setupCfg: ChannelSetup | null = null;
  let connected = false;
  let reconnectDelay = 1000;
  let teardownRequested = false;

  // Maps populated at setup() once the bot is identified and channels are resolved.
  // mmChannelId → ChannelConfig (for non-DM channels)
  const channelConfigById = new Map<string, ChannelConfig>();
  // folder → mmChannelId (reverse lookup for deliver/setTyping)
  const channelIdByFolder = new Map<string, string>();
  // The DM ChannelConfig, if any (DM uses dynamic channel ids)
  let dmConfig: ChannelConfig | null = null;
  // dmChannelId → has been registered
  const registeredDms = new Set<string>();

  // Per-mg pending root_id (so the bot's reply lands in the same thread)
  // Key: platformId, Value: root_id from latest inbound
  const pendingRootIdByPlatform = new Map<string, string | undefined>();

  // Serialization chain for inbound WS 'posted' events (see the handler).
  let handlePostedChain: Promise<void> = Promise.resolve();
  // Newest post.create_at we've processed — reconnect catch-up fetches
  // everything after this so messages posted during a WS gap aren't lost.
  let lastPostCreateAt = 0;
  let hadFirstConnect = false;

  async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${cfg!.url}/api/v4${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg!.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} /api/v4${urlPath} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async function downloadFile(fileId: string): Promise<{ name: string; mimeType: string; data: Buffer }> {
    const info = (await api('GET', `/files/${fileId}/info`)) as MmFileInfo;
    // Attachments are fully buffered + base64-encoded into the inbound DB row
    // (×1.33) — an unbounded download can OOM the single host process.
    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
    if (typeof info.size === 'number' && info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large (${info.size} bytes > ${MAX_ATTACHMENT_BYTES})`);
    }
    const res = await fetch(`${cfg!.url}/api/v4/files/${fileId}`, {
      headers: { Authorization: `Bearer ${cfg!.token}` },
    });
    if (!res.ok) throw new Error(`file download ${fileId} → ${res.status}`);
    const arr = await res.arrayBuffer();
    const data = Buffer.from(arr);
    const mimeType = info.mime_type || info.mimeType || 'application/octet-stream';

    // Office formats (.docx/.xlsx/.pptx/.odt/...) are not natively understood
    // by the Claude API. Convert them to PDF (which IS native via document
    // blocks) using libreoffice on the host. Falls back to passing the raw
    // file through if libreoffice isn't installed or the conversion fails —
    // logged but non-fatal.
    if (OFFICE_EXTS.test(info.name)) {
      const converted = await convertOfficeToPdf(data, info.name);
      if (converted) return converted;
    }

    return { name: info.name, mimeType, data };
  }

  async function ensureRegistration(ch: ChannelConfig, dmChannelId?: string): Promise<string> {
    const platformId = platformIdFor(ch.folder, dmChannelId);

    let mg = getMessagingGroupByPlatform('mattermost', platformId);
    if (!mg) {
      const mgId = `mg-mm-${ch.folder}${dmChannelId ? `-${dmChannelId.slice(0, 8)}` : ''}`;
      const newMg = {
        id: mgId,
        channel_type: 'mattermost',
        platform_id: platformId,
        name: ch.channel ?? (dmChannelId ? `DM ${dmChannelId.slice(0, 8)}` : ch.folder),
        is_group: dmChannelId ? 0 : 1,
        unknown_sender_policy: 'public' as const,
        denied_at: null,
        created_at: new Date().toISOString(),
      };
      createMessagingGroup(newMg);
      mg = newMg;
      log.info('Mattermost: created messaging_group', { mgId, platformId });
    }

    let agentGroup = getAgentGroupByFolder(ch.folder);
    if (!agentGroup) {
      const agId = `ag-${ch.folder}`;
      createAgentGroup({
        id: agId,
        name: `Claw (${ch.channel ?? ch.folder})`,
        folder: ch.folder,
        agent_provider: null,
        created_at: new Date().toISOString(),
      });
      agentGroup = getAgentGroupByFolder(ch.folder)!;
      log.info('Mattermost: created agent_group', { agentGroupId: agentGroup.id, folder: ch.folder });
    }

    const existingMga = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
    if (!existingMga) {
      createMessagingGroupAgent({
        id: `mga-mm-${ch.folder}${dmChannelId ? `-${dmChannelId.slice(0, 8)}` : ''}`,
        messaging_group_id: mg.id,
        agent_group_id: agentGroup.id,
        engage_mode: ch.requireMention ? 'mention' : 'pattern',
        engage_pattern: ch.requireMention ? null : '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: new Date().toISOString(),
      });
      log.info('Mattermost: wired messaging_group → agent_group', {
        mgId: mg.id,
        agentGroupId: agentGroup.id,
        engageMode: ch.requireMention ? 'mention' : 'pattern',
      });
    }

    return platformId;
  }

  /**
   * Idempotent import of `groups/<folder>/crons.json` into v2's task scheduler.
   *
   * Each cron entry becomes a `messages_in` row with `kind='task'`, the cron
   * expression in `recurrence`, and the next firing time computed via
   * cron-parser. We use a deterministic id per (folder, cron index) so
   * re-running this on every boot doesn't insert duplicates.
   *
   * Two entry shapes supported (v1 mattermost-bot legacy):
   *   { schedule: "0 7 * * *", prompt: "..." }   → wakes the agent with prompt
   *   { schedule: "0 7 * * *", message: "..." }  → posts message directly (no agent)
   */
  async function importCronsForFolder(ch: ChannelConfig): Promise<void> {
    const cronsFile = path.join(GROUPS_DIR, ch.folder, 'crons.json');
    if (!fs.existsSync(cronsFile)) return;

    let entries: Array<{ schedule: string; prompt?: string; message?: string }>;
    try {
      entries = JSON.parse(fs.readFileSync(cronsFile, 'utf-8'));
    } catch (err) {
      log.warn('Mattermost: failed to parse crons.json', { folder: ch.folder, err: (err as Error).message });
      return;
    }
    if (!Array.isArray(entries) || entries.length === 0) return;

    const platformId = platformIdFor(ch.folder);
    const mg = getMessagingGroupByPlatform('mattermost', platformId);
    if (!mg) return;
    const ag = getAgentGroupByFolder(ch.folder);
    if (!ag) return;
    const { session } = resolveSession(ag.id, mg.id, null, 'shared');

    const db = openInboundDb(ag.id, session.id);
    try {
      const { CronExpressionParser } = await import('cron-parser');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.schedule) continue;

        // Deterministic id: skip if already present (idempotent).
        const taskId = `cron-mm-${ch.folder}-${i}`;
        const existing = db.prepare('SELECT id FROM messages_in WHERE series_id = ? OR id = ?').get(taskId, taskId) as
          | { id: string }
          | undefined;
        if (existing) continue;

        let processAfter: string;
        try {
          const interval = CronExpressionParser.parse(entry.schedule, { tz: TIMEZONE });
          processAfter = String(interval.next().toISOString());
        } catch (err) {
          log.warn('Mattermost: invalid cron schedule, skipping', {
            folder: ch.folder,
            schedule: entry.schedule,
            err: (err as Error).message,
          });
          continue;
        }

        // For 'prompt' entries, the agent processes the prompt and replies.
        // For 'message' entries (legacy reminder pattern), we still wake the
        // agent — its CLAUDE.md already explains "if message is exactly X,
        // post X verbatim". Simplest path that doesn't require a separate
        // direct-post code path.
        const promptText =
          entry.prompt ??
          (entry.message
            ? `Poste exactement ce message dans le canal, sans rien ajouter ni reformuler:\n\n${entry.message}`
            : null);
        if (!promptText) continue;

        insertTask(db, {
          id: taskId,
          processAfter,
          recurrence: entry.schedule,
          platformId,
          channelType: 'mattermost',
          threadId: null,
          content: JSON.stringify({ prompt: promptText }),
        });
        log.info('Mattermost: imported cron', {
          folder: ch.folder,
          schedule: entry.schedule,
          processAfter,
          taskId,
        });
      }
    } finally {
      db.close();
    }
  }

  /**
   * Default weekly summary task — applied to EVERY mattermost channel,
   * always, at adapter startup. Idempotent (deterministic taskId, INSERT
   * skipped if already present). Fires every Sunday at 18:00 local time.
   *
   * Channel-specific crons in crons.json are layered on top — they don't
   * disable this default. If a channel author wants different summary
   * timing, they can add their own cron with their preferred schedule;
   * the default still runs alongside (Phil can dedupe by adjusting one
   * or the other if it becomes noisy).
   *
   * The prompt asks the agent to write the summary into
   * `semaines/semaine_<YYYY-WNN>.md`, creating the directory if needed.
   */
  async function addDefaultWeeklySummary(ch: ChannelConfig): Promise<void> {
    const platformId = platformIdFor(ch.folder);
    const mg = getMessagingGroupByPlatform('mattermost', platformId);
    if (!mg) return;
    const ag = getAgentGroupByFolder(ch.folder);
    if (!ag) return;
    const { session } = resolveSession(ag.id, mg.id, null, 'shared');

    const taskId = `task-default-weekly-summary-${ch.folder}`;
    const schedule = '0 18 * * 0';

    const db = openInboundDb(ag.id, session.id);
    try {
      const existing = db.prepare('SELECT id FROM messages_in WHERE id = ? OR series_id = ?').get(taskId, taskId) as
        | { id: string }
        | undefined;
      if (existing) return;

      const { CronExpressionParser } = await import('cron-parser');
      let processAfter: string;
      try {
        processAfter = String(CronExpressionParser.parse(schedule, { tz: TIMEZONE }).next().toISOString());
      } catch (err) {
        log.warn('Mattermost: failed to compute default weekly summary nextRun', {
          folder: ch.folder,
          err: (err as Error).message,
        });
        return;
      }

      const promptText =
        'TÂCHE SILENCIEUSE — ne poste AUCUN message dans le canal. Fais un résumé de la semaine écoulée sur ce canal. ' +
        "Consulte l'historique des conversations de la semaine et les fichiers du workspace. " +
        'Mentionne les principaux sujets abordés, les actions / décisions prises, les points marquants et les éventuelles questions en attente. ' +
        'Sauvegarde le résumé dans `semaines/semaine_<YYYY-WNN>.md` (numéro de semaine ISO de la date courante). ' +
        "Si le dossier `semaines/` n'existe pas, crée-le. " +
        'Quand le fichier est écrit, termine ton turn sans répondre — pas de message de confirmation, pas de récap, rien dans le canal.';

      insertTask(db, {
        id: taskId,
        processAfter,
        recurrence: schedule,
        platformId,
        channelType: 'mattermost',
        threadId: null,
        content: JSON.stringify({ prompt: promptText }),
      });
      log.info('Mattermost: added default weekly summary task', {
        folder: ch.folder,
        schedule,
        processAfter,
        taskId,
      });
    } finally {
      db.close();
    }
  }

  function buildWsUrl(): string {
    return cfg!.url.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/api/v4/websocket';
  }

  function connect(): void {
    if (teardownRequested) return;
    const wsUrl = buildWsUrl();
    const sock = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cfg!.token}` } });
    ws = sock;
    let seq = 1;

    // Defense-in-depth keepalive — two complementary layers:
    //
    //  1. TCP keepalive (kernel SO_KEEPALIVE): catches hard network
    //     failures (cable yanked, peer kernel crashed, NAT entry
    //     evicted). Without this, a dead TCP connection takes the OS
    //     retransmit timeout (~15 min) to close.
    //  2. WebSocket ping/pong (RFC 6455 frames): catches application-
    //     layer silence — the TCP socket is healthy but Mattermost or
    //     its reverse proxy stopped pushing events. The kernel still
    //     reports ESTAB so 'close' never fires; only an app-level probe
    //     can detect this.
    //
    // 'upgrade' fires once per HTTP→WS handshake with the underlying
    // socket. We enable TCP keepalive there. The ping/pong below runs
    // until the socket closes for any reason.
    sock.on('upgrade', (req) => {
      const tcp = (req as { socket?: { setKeepAlive?: (enable: boolean, initialDelay: number) => void } }).socket;
      if (tcp && typeof tcp.setKeepAlive === 'function') {
        // 30s initial delay before first probe; subsequent probes use
        // the kernel default (typically 75s × 9 retries → ~10 min total
        // before declaring dead). Sufficient given the WS-level probe
        // will catch most cases first.
        tcp.setKeepAlive(true, 30_000);
      }
    });

    let lastPongAt = Date.now();
    const pingInterval = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      try {
        sock.ping();
      } catch (err) {
        log.warn('Mattermost: WS ping send failed', { err: (err as Error).message });
      }
      // If we haven't seen a pong in 60s, the connection is dead.
      if (Date.now() - lastPongAt > 60_000) {
        log.warn('Mattermost: WS pong timeout — forcing reconnect');
        try {
          sock.terminate();
        } catch {
          /* swallow */
        }
      }
    }, 30_000);
    sock.on('pong', () => {
      lastPongAt = Date.now();
    });

    sock.on('open', () => {
      try {
        sock.send(JSON.stringify({ seq: seq++, action: 'authentication_challenge', data: { token: cfg!.token } }));
      } catch (err) {
        log.warn('Mattermost: WS auth send failed', { err: (err as Error).message });
      }
    });

    sock.on('message', (raw: Buffer) => {
      let msg: { event?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.event === 'hello') {
        connected = true;
        reconnectDelay = 1000;
        log.info('Mattermost WS ready');
        // After a RECONNECT (not the first connect), fetch every post created
        // while the socket was down — Mattermost has no server-side replay,
        // so without this the gap's messages are silently lost.
        if (hadFirstConnect && lastPostCreateAt > 0) {
          handlePostedChain = handlePostedChain
            .then(() => catchUpMissedPosts(lastPostCreateAt))
            .catch((err) => {
              log.warn('Mattermost: reconnect catch-up failed', { err: (err as Error).message });
            });
        }
        hadFirstConnect = true;
        return;
      }

      if (msg.event !== 'posted') return;
      // Serialize handlePosted calls: concurrent processing lets a fast
      // message overtake a slow one (attachment download + libreoffice
      // conversion), inverting the conversation order in messages_in and
      // clobbering pendingRootIdByPlatform with the wrong thread. The catch
      // also surfaces async failures — without it a throw inside would
      // silently reject the void'd promise.
      handlePostedChain = handlePostedChain
        .then(() => handlePosted(msg.data ?? {}))
        .catch((err) => {
          log.warn('Mattermost: handlePosted threw', { err: (err as Error).message });
        });
    });

    sock.on('close', (code) => {
      connected = false;
      clearInterval(pingInterval);
      if (teardownRequested) return;
      log.warn('Mattermost WS closed, reconnecting', { code, delayMs: reconnectDelay });
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    sock.on('error', (err: Error) => {
      log.warn('Mattermost WS error', { err: err.message });
    });
  }

  /**
   * Fetch and route every post created after `sinceMs` in the channels we
   * know about (configured channels + already-registered DMs). Called after
   * a WS reconnect — the gap's posts never arrive via the socket. Duplicate
   * boundary posts are harmless: the router skips already-inserted ids.
   */
  async function catchUpMissedPosts(sinceMs: number): Promise<void> {
    const channelIds = new Set<string>([...channelConfigById.keys(), ...registeredDms]);
    for (const chId of channelIds) {
      try {
        const res = (await api('GET', `/channels/${chId}/posts?since=${sinceMs}`)) as {
          order?: string[];
          posts?: Record<string, MmPost>;
        };
        const order = res.order ?? [];
        if (order.length === 0) continue;
        // `order` is newest-first — replay chronologically.
        for (const postId of [...order].reverse()) {
          const p = res.posts?.[postId];
          if (!p || (p.create_at ?? 0) <= sinceMs) continue;
          log.info('Mattermost: replaying post missed during WS gap', { postId, channelId: chId });
          await handlePosted({
            post: JSON.stringify(p),
            channel_type: registeredDms.has(chId) ? 'D' : 'O',
          });
        }
      } catch (err) {
        log.warn('Mattermost: catch-up fetch failed for channel', { chId, err: (err as Error).message });
      }
    }
  }

  async function handlePosted(data: Record<string, unknown>): Promise<void> {
    let post: MmPost;
    try {
      post = JSON.parse(data.post as string) as MmPost;
    } catch {
      return;
    }

    // Advance the reconnect catch-up watermark for every post seen (our own
    // included — they're skipped below but must still move the boundary).
    if (typeof post.create_at === 'number' && post.create_at > lastPostCreateAt) {
      lastPostCreateAt = post.create_at;
    }

    // Skip our own messages and system posts
    if (!me || post.user_id === me.id) return;
    if (post.type) return;

    const mmChannelType = data.channel_type as string;
    const isDM = mmChannelType === 'D';

    let chCfg = channelConfigById.get(post.channel_id);
    let dmChannelId: string | undefined;

    if (!chCfg) {
      if (isDM && dmConfig) {
        chCfg = dmConfig;
        dmChannelId = post.channel_id;
        // Lazy-register this DM channel
        if (!registeredDms.has(post.channel_id)) {
          try {
            await ensureRegistration(dmConfig, post.channel_id);
            await addDefaultWeeklySummary(dmConfig);
            registeredDms.add(post.channel_id);
          } catch (err) {
            log.error('Mattermost: failed to register DM channel', { err, channelId: post.channel_id });
            return;
          }
        }
      } else {
        // Not a configured channel — ignore
        return;
      }
    }

    const mentionsArr: string[] = data.mentions ? JSON.parse(data.mentions as string) : [];
    const text = post.message ?? '';
    const isMention = isDM || mentionsArr.includes(me.id) || text.includes(`@${me.username}`);

    if (chCfg.requireMention && !isMention) return;

    const senderName = (data.sender_name as string) ?? post.user_id;

    // Strip the @mention from the visible text if present
    const cleanText = me ? text.replace(new RegExp(`@${me.username}\\s*`, 'gi'), '').trim() : text;

    // Download attachments (images + documents) and base64-encode for the agent
    const attachments: Array<Record<string, unknown>> = [];
    for (const fid of post.file_ids ?? []) {
      try {
        const f = await downloadFile(fid);
        attachments.push({
          type: f.mimeType.startsWith('image/') ? 'image' : 'document',
          name: f.name,
          mimeType: f.mimeType,
          size: f.data.length,
          data: f.data.toString('base64'),
        });
      } catch (err) {
        log.warn('Mattermost: attachment download failed', { fid, err: (err as Error).message });
      }
    }

    const platformId = platformIdFor(chCfg.folder, dmChannelId);

    // Remember this message's root_id so deliver() puts the reply in the same thread.
    // Mattermost root_id == '' on top-level posts; we store undefined so we don't pin
    // future top-level replies into a stale thread.
    pendingRootIdByPlatform.set(platformId, post.root_id || undefined);

    const content: Record<string, unknown> = {
      text: cleanText,
      sender: senderName,
      senderId: `mattermost:${post.user_id}`,
      channelId: post.channel_id,
      folder: chCfg.folder,
    };
    if (post.root_id) content.rootId = post.root_id;
    if (attachments.length > 0) content.attachments = attachments;

    try {
      await setupCfg!.onInbound(platformId, null, {
        id: `mm-${post.id}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content,
        isMention,
        isGroup: !isDM,
      });
    } catch (err) {
      log.error('Mattermost: onInbound threw', { err });
    }
  }

  const adapter: ChannelAdapter = {
    name: 'mattermost',
    channelType: 'mattermost',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupCfg = config;

      me = (await api('GET', '/users/me')) as BotIdentity;
      log.info('Mattermost: bot identified', { id: me.id, username: me.username });

      const teams = (await api('GET', '/users/me/teams')) as Array<{ id: string; name: string }>;
      if (!teams.length) throw new Error('Mattermost: bot is in no team');

      for (const ch of cfg.channels) {
        if (ch.isDM) {
          dmConfig = ch;
          // DMs are lazy-registered when an event arrives
          continue;
        }
        if (!ch.channel) {
          log.warn('Mattermost: skipping non-DM entry without channel name', { folder: ch.folder });
          continue;
        }
        let resolved = false;
        for (const team of teams) {
          try {
            const c = (await api('GET', `/teams/${team.id}/channels/name/${ch.channel}`)) as {
              id: string;
              name: string;
            };
            channelConfigById.set(c.id, ch);
            channelIdByFolder.set(ch.folder, c.id);
            await ensureRegistration(ch);
            await importCronsForFolder(ch);
            await addDefaultWeeklySummary(ch);
            log.info('Mattermost: monitoring channel', {
              channel: ch.channel,
              channelId: c.id,
              folder: ch.folder,
              team: team.name,
            });
            resolved = true;
            break;
          } catch {
            // try next team
          }
        }
        if (!resolved) {
          log.warn('Mattermost: channel not found in any team', { channel: ch.channel });
        }
      }

      connect();
    },

    async teardown(): Promise<void> {
      teardownRequested = true;
      connected = false;
      if (ws) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
        ws = null;
      }
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const parsed = parsePlatformId(platformId);
      if (!parsed) {
        log.warn('Mattermost: deliver to malformed platformId', { platformId });
        return undefined;
      }

      // Resolve channel id: DM uses the dmChannelId encoded in the platformId,
      // regular channels look up by folder.
      let mmChannelId: string | undefined;
      if (parsed.dmChannelId) {
        mmChannelId = parsed.dmChannelId;
      } else {
        mmChannelId = channelIdByFolder.get(parsed.folder);
      }
      if (!mmChannelId) {
        // Throw, don't return undefined — the caller marks undefined as
        // delivered (delivery.ts), which silently loses the message.
        throw new Error(`Mattermost: no Mattermost channel id for platformId ${platformId}`);
      }

      // Dispatch edit / reaction / delete operations before normal text delivery.
      // These come from the agent-runner's edit_message / add_reaction /
      // delete_message MCP tools (see container/agent-runner/src/mcp-tools/core.ts).
      //
      // The messageId we receive has been wrapped twice:
      //   - inbound messages: adapter prefixes `mm-<post_id>`, router suffixes
      //     `:<agent_group_id>` to disambiguate fan-out.
      //   - outbound messages: the host writes the platform_message_id back to
      //     the agent-runner without wrapping (it's the raw Mattermost post id).
      // Strip both to get back to the raw Mattermost post id before calling the API.
      const content = (message.content as Record<string, unknown> | undefined) ?? {};
      const operation = typeof content.operation === 'string' ? content.operation : undefined;
      const unwrapPostId = (raw: string): string => {
        const noAgent = raw.split(':')[0]; // strip `:ag-...` suffix
        return noAgent.startsWith('mm-') ? noAgent.slice(3) : noAgent;
      };
      if (operation === 'edit' && typeof content.messageId === 'string') {
        const postId = unwrapPostId(content.messageId);
        try {
          await api('PUT', `/posts/${postId}/patch`, {
            message: (content.text as string) ?? '',
          });
          return content.messageId;
        } catch (err) {
          // Re-throw so the host's delivery retry path handles it — returning
          // undefined would mark the operation delivered when nothing happened.
          log.error('Mattermost: edit failed', { err: (err as Error).message, postId });
          throw err;
        }
      }
      if (operation === 'reaction' && typeof content.messageId === 'string' && typeof content.emoji === 'string') {
        if (!me) {
          log.warn('Mattermost: cannot add reaction — bot identity unknown');
          return undefined;
        }
        const postId = unwrapPostId(content.messageId);
        try {
          await api('POST', '/reactions', {
            user_id: me.id,
            post_id: postId,
            emoji_name: content.emoji,
          });
          return content.messageId;
        } catch (err) {
          log.error('Mattermost: reaction failed', { err: (err as Error).message, postId });
          throw err;
        }
      }
      if (operation === 'delete' && typeof content.messageId === 'string') {
        const postId = unwrapPostId(content.messageId);
        try {
          await api('DELETE', `/posts/${postId}`);
          return content.messageId;
        } catch (err) {
          log.error('Mattermost: delete failed', { err: (err as Error).message, postId });
          throw err;
        }
      }

      const text = extractText(message);
      const hasFiles = Array.isArray(message.files) && message.files.length > 0;
      if ((text === null || text.length === 0) && !hasFiles) {
        log.debug('Mattermost: skipping deliver with empty text', { platformId });
        return undefined;
      }

      // Use the last seen root_id for this platformId so threaded conversations
      // stay in their thread. Deliberately NOT cleared on use: a turn can emit
      // several outbound posts (live-status 🔧 post first, then the actual
      // reply, then more chunks) and all of them belong in the thread. The
      // entry is overwritten (or unset) by the next inbound message, so
      // unrelated later replies don't get pinned into a stale thread.
      const rootId = pendingRootIdByPlatform.get(platformId);

      // Upload file attachments first to obtain file_ids; Mattermost requires
      // them on the post itself (no edit-with-files round-trip needed).
      const fileIds: string[] = [];
      if (hasFiles) {
        for (const f of message.files!) {
          try {
            const form = new FormData();
            form.append('channel_id', mmChannelId);
            form.append('files', new Blob([f.data], { type: 'application/octet-stream' }), f.filename);
            const uploadRes = await fetch(`${cfg!.url}/api/v4/files`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${cfg!.token}` },
              body: form,
            });
            if (!uploadRes.ok) {
              log.error('Mattermost: file upload failed', {
                filename: f.filename,
                status: uploadRes.status,
                body: (await uploadRes.text()).slice(0, 200),
              });
              continue;
            }
            const json = (await uploadRes.json()) as { file_infos?: Array<{ id: string }> };
            const fid = json.file_infos?.[0]?.id;
            if (fid) fileIds.push(fid);
          } catch (err) {
            log.error('Mattermost: file upload error', {
              filename: f.filename,
              err: (err as Error).message,
            });
          }
        }
      }

      try {
        const post = (await api('POST', '/posts', {
          channel_id: mmChannelId,
          message: text ?? '',
          ...(rootId ? { root_id: rootId } : {}),
          ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
        })) as { id: string };
        return post.id;
      } catch (err) {
        // Throw so a transient API failure (502 during a Mattermost restart…)
        // lands in the delivery retry path instead of being marked delivered.
        log.error('Mattermost: deliver failed', { err: (err as Error).message, platformId });
        throw err;
      }
    },

    async setTyping(platformId, _threadId): Promise<void> {
      const parsed = parsePlatformId(platformId);
      if (!parsed) return;

      let mmChannelId: string | undefined;
      if (parsed.dmChannelId) {
        mmChannelId = parsed.dmChannelId;
      } else {
        mmChannelId = channelIdByFolder.get(parsed.folder);
      }
      if (!mmChannelId) return;

      try {
        // REST API — more reliable than WS user_typing for bot accounts
        await api('POST', `/users/me/typing`, { channel_id: mmChannelId, parent_id: '' });
      } catch {
        // best-effort
      }
    },
  };

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('mattermost', { factory: createAdapter });

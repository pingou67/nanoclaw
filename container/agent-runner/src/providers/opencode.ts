import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createOpencodeClient, type OpencodeClient, type ToolPart } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { summarizeToolUse } from './summarize.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;
  // Direct API key (e.g. for Mistral). Fallback to 'placeholder' when the
  // upstream is reached via an injection proxy that adds Bearer auth itself
  // (existing pattern for OpenRouter via scripts/opencode-injector-proxy.mjs).
  const apiKey = process.env.OPENCODE_API_KEY || 'placeholder';

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  log(
    `OPENCODE_PROVIDER=${provider} OPENCODE_MODEL=${model ?? '(unset)'} ` +
    `OPENCODE_SMALL_MODEL=${smallModel ?? '(unset)'} ` +
    `ANTHROPIC_BASE_URL=${proxyUrl ?? '(unset)'} OPENCODE_API_KEY=${apiKey === 'placeholder' ? '(unset/placeholder)' : 'set'}`,
  );
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  // Optional reasoning/thinking config — set OPENCODE_REASONING_EFFORT
  // (low/medium/high) to enable thinking mode on the upstream model.
  // Lands in the per-model options bag, which OpenCode passes through
  // to the underlying provider plugin (e.g. openrouter expects
  // `reasoning: { effort: ... }` in extraBody for thinking models).
  const reasoningEffort = process.env.OPENCODE_REASONING_EFFORT;
  // Comma-separated OpenRouter provider order (e.g. "NextBit,Novita"). Injected
  // into extraBody.provider so OpenRouter routes only to these providers (with
  // fallback). Reproduces the routing the old opencode-injector-proxy.mjs did.
  const openrouterProviders = (process.env.OPENROUTER_PROVIDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const extraBody: Record<string, unknown> = {};
  if (reasoningEffort) extraBody.reasoning = { effort: reasoningEffort };
  if (openrouterProviders.length > 0) {
    extraBody.provider = { order: openrouterProviders, allow_fallbacks: true };
  }
  const modelOptions: Record<string, unknown> = {};
  if (reasoningEffort) modelOptions.reasoning = { effort: reasoningEffort };
  if (Object.keys(extraBody).length > 0) modelOptions.extraBody = extraBody;

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey, baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [
                      mid,
                      { id: mid, name: mid, tool_call: true, reasoning: !!reasoningEffort, options: modelOptions },
                    ]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  // Per-group opencode plugin list. Read from NANOCLAW_OPENCODE_PLUGINS (a
  // JSON array of npm package names), passed by the host via the group's
  // `env` field. Namespaced under NANOCLAW_ to avoid clashing with any
  // OPENCODE_* env var the opencode binary might add in the future.
  const plugins = parsePluginEnv(process.env.NANOCLAW_OPENCODE_PLUGINS);

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    compaction: { maxContext: 165000 },
    provider: providerOptions,
    instructions,
    mcp,
    ...(plugins.length > 0 ? { plugin: plugins } : {}),
  };
}

/**
 * Parse the NANOCLAW_OPENCODE_PLUGINS env var as a JSON array of strings.
 * Tolerates missing/unset/unparseable values — returns [] on any error so
 * the opencode config remains well-formed. Exported for testing.
 */
export function parsePluginEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return [];
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

/**
 * Translate a single `message.part.updated` ToolPart into a progress event
 * for the live status post, or return null if this callID has already been
 * emitted or the part is in a terminal state. Mutates `emittedCallIds` on
 * success so subsequent transitions of the same call (pending → running →
 * completed) yield only one progress event per call.
 *
 * Exported for testing — production code calls this from the gen() switch
 * in OpenCodeProvider.start().
 */
export function toolPartToProgress(
  part: ToolPart,
  emittedCallIds: Set<string>,
): ProviderEvent | null {
  if (emittedCallIds.has(part.callID)) return null;
  if (part.state.status !== 'pending' && part.state.status !== 'running') return null;
  emittedCallIds.add(part.callID);
  return {
    type: 'progress',
    message: summarizeToolUse(part.tool, part.state.input ?? {}),
  };
}

/**
 * Decide whether the opencode SSE stream has been idle longer than the
 * configured timeout, and if so, force it to release so the turn loop's
 * pending `await stream.next()` can resolve and observe the timeout.
 *
 * Idempotent: once `eventTimedOut` is true, returns `timedOut: false` and
 * does NOT touch the stream. This is what stops the setInterval from
 * spamming the timeout log every 5s after the first detection.
 *
 * Exported for testing — production callers wrap this in a setInterval
 * and apply the side effects (log, clear `self.activeSessionId`, destroy
 * the shared runtime, kick the outer wait).
 */
export function checkIdleTimeout(
  lastEventAt: number,
  eventTimedOut: boolean,
  idleTimeoutMs: number,
  stream: { return?: (value?: unknown) => Promise<unknown> | void } | undefined,
): { eventTimedOut: boolean; timedOut: boolean } {
  if (eventTimedOut) return { eventTimedOut, timedOut: false };
  if (Date.now() - lastEventAt > idleTimeoutMs) {
    void stream?.return?.(undefined);
    return { eventTimedOut: true, timedOut: true };
  }
  return { eventTimedOut, timedOut: false };
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        // Parse attachment markers `[<type>: <name> — saved to <path>]` written
        // by the agent-runner formatter (formatter.ts:230) and translate them
        // into OpenCode FilePartInput so vision-capable models receive the
        // bytes directly instead of just a path string they can't decode.
        const fileParts: Array<{ type: 'file'; mime: string; filename?: string; url: string }> = [];
        const ATTACH_RE = /\[(image|document|file|attachment):\s*([^—\]]+?)\s+—\s+saved to\s+([^\]]+)\]/gi;
        const MIME_BY_EXT: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
          webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
          pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
        };
        for (const m of text.matchAll(ATTACH_RE)) {
          const filename = m[2].trim();
          const containerPath = m[3].trim();
          try {
            const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
            const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
            // PDFs: rasterize each page to PNG via pdftoppm so vision-only
            // models (Gemma, etc.) can read them. Office files have already
            // been converted to PDF by the host adapter.
            if (mime === 'application/pdf') {
              const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfimg-'));
              const prefix = path.join(tmpDir, 'page');
              const r = spawnSync('pdftoppm', ['-png', '-r', '150', containerPath, prefix], {
                encoding: 'utf8',
                timeout: 60_000,
              });
              if (r.status !== 0) {
                log(`pdftoppm failed for ${containerPath}: ${r.stderr || r.error?.message}`);
                continue;
              }
              const pages = fs
                .readdirSync(tmpDir)
                .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
                .sort();
              for (const page of pages) {
                const data = fs.readFileSync(path.join(tmpDir, page));
                fileParts.push({
                  type: 'file',
                  mime: 'image/png',
                  filename: `${filename}#${page.replace(/^page-|\.png$/g, '')}`,
                  url: `data:image/png;base64,${data.toString('base64')}`,
                });
              }
              fs.rmSync(tmpDir, { recursive: true, force: true });
              continue;
            }
            const data = fs.readFileSync(containerPath);
            fileParts.push({
              type: 'file',
              mime,
              filename,
              url: `data:${mime};base64,${data.toString('base64')}`,
            });
          } catch (err) {
            log(`attachment read failed for ${containerPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }, ...fileParts] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        // Dedupe tool progress events: a single tool call transitions
        // pending → running → completed, but the live status should only
        // show one update per callID. Emit on the first non-terminal state.
        const emittedToolCallIds = new Set<string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          const r = checkIdleTimeout(lastEventAt, eventTimedOut, IDLE_TIMEOUT_MS, stream);
          if (!r.timedOut) return;
          log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
          eventTimedOut = true;
          self.activeSessionId = undefined;
          destroySharedRuntime();
          kick();
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as
                  | { type?: string; messageID?: string; text?: string }
                  | ToolPart
                  | undefined;
                if (!part) break;
                if (part.type === 'text' && part.messageID && (part as { text?: string }).text) {
                  partTextByMessageId.set(part.messageID, (part as { text: string }).text);
                } else if (part.type === 'tool') {
                  const progress = toolPartToProgress(part as ToolPart, emittedToolCallIds);
                  if (progress) yield progress;
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));

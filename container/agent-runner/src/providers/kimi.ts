/**
 * Kimi Code provider — drives the `kimi` CLI (MoonshotAI/kimi-cli) as a
 * per-turn subprocess, the same shape as the agy provider.
 *
 * Why a subprocess and not an SDK: kimi ships as a single binary whose
 * non-interactive surface is `kimi -p <prompt> --output-format stream-json`.
 * That stream is an OpenAI-shaped chat log on stdout, one JSON object per
 * line:
 *
 *   {"role":"assistant","tool_calls":[{"function":{"name":"Bash","arguments":"{…}"}}]}
 *   {"role":"tool","tool_call_id":"…","content":"…"}
 *   {"role":"assistant","content":"…"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_…"}
 *
 * Two properties of that stream drive the parser below. Tool output and status
 * notices are ALSO written to stdout as bare text (`2`, `Shell cwd was reset
 * to …`), so every line must be JSON-probed and silently dropped when it isn't
 * an object — a strict parser would crash on the first Bash call. And the
 * session id only arrives in the trailing `meta` line, so the continuation is
 * published at the END of the first turn rather than up front.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { registerProvider } from './provider-registry.js';
import { summarizeToolUse } from './summarize.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[kimi-provider] ${msg}`);
}

/** KIMI_CODE_HOME inside the container — a writable mount staged by the host. */
const KIMI_HOME = process.env.KIMI_CODE_HOME || '/kimi-home';

/** The operator's own config.toml, mounted read-only by the host provider. */
const BASE_CONFIG_PATH = '/kimi-base-config.toml';

/**
 * Concrete files that make up the agent's standing instructions.
 *
 * Kimi reads `AGENTS.md` and never `CLAUDE.md`, and it does NOT expand the
 * `@./…` includes our composed CLAUDE.md is built from — pointing it at that
 * file would hand the model a list of unresolved import lines. So we
 * concatenate the concrete fragment files instead, which is the same
 * conclusion the opencode provider reached for its `instructions` list. Keep
 * the two lists in sync.
 */
const INSTRUCTION_SOURCES = [
  '/app/CLAUDE.md',
  '/workspace/agent/.claude-fragments/*.md',
  '/workspace/agent/CLAUDE.local.md',
];

/**
 * Ceiling for the prompt passed as an argv element. Linux caps a single
 * argument at MAX_ARG_STRLEN (128 KiB) regardless of the much larger ARG_MAX,
 * and kimi has no stdin prompt mode — `--output-format` is rejected outside
 * `-p`. Past this size the prompt is spilled to a file and the model is told
 * to read it, which degrades gracefully instead of dying on E2BIG.
 */
const MAX_PROMPT_ARG_BYTES = 96_000;

/**
 * kimi's k3 catalog declares `support_efforts = ["low", "high", "max"]` while
 * our `effort` column carries the Claude vocabulary. Map onto the nearest kimi
 * tier; anything unrecognized returns undefined so the model default applies.
 */
export function mapEffort(effort?: string): string | undefined {
  switch ((effort || '').toLowerCase()) {
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'max';
    default:
      return undefined;
  }
}

/**
 * Translate our MCP map into kimi's Claude-compatible `mcp.json` shape.
 *
 * Remote servers are keyed off `url` (+ optional `headers`); stdio servers off
 * `command`. `instructions` is a nanoclaw-only key and is dropped — kimi
 * validates the object and the per-server guidance reaches the model anyway
 * through the `.claude-fragments/mcp-<name>.md` files folded into AGENTS.md.
 */
export function mcpServersToKimiConfig(
  servers: Record<string, McpServerConfig> | undefined,
): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (cfg.url) {
      mcpServers[name] = {
        url: cfg.url,
        ...(cfg.type ? { type: cfg.type } : {}),
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      };
    } else if (cfg.command) {
      mcpServers[name] = {
        command: cfg.command,
        ...(cfg.args ? { args: cfg.args } : {}),
        ...(cfg.env ? { env: cfg.env } : {}),
      };
    }
  }
  return { mcpServers };
}

/**
 * Overlay the group's model/effort onto the operator's base config.toml.
 *
 * Line-based on purpose: the base file carries the operator's provider block
 * (OAuth storage key, base_url, model catalog) which must survive verbatim,
 * and re-emitting a parsed TOML would risk dropping anything we don't model.
 * A table is only stripped when we have a replacement for it, so a group that
 * pins neither field inherits the operator's settings untouched.
 */
export function applyConfigOverrides(baseToml: string, opts: { model?: string; effort?: string }): string {
  const effort = mapEffort(opts.effort);
  const kept: string[] = [];
  let inThinkingTable = false;

  for (const line of baseToml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) inThinkingTable = trimmed === '[thinking]';
    if (effort && inThinkingTable) continue;
    if (opts.model && /^\s*default_model\s*=/.test(line)) continue;
    kept.push(line);
  }

  const head = opts.model ? [`default_model = ${JSON.stringify(opts.model)}`] : [];
  const tail = effort ? ['', '[thinking]', 'enabled = true', `effort = ${JSON.stringify(effort)}`] : [];
  return [...head, ...kept, ...tail].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Resolve the instruction source list to concrete existing files. Only a
 * trailing `*.md` segment is treated as a glob — that is the single pattern
 * shape the list uses, and hand-rolling it avoids a dependency.
 */
export function resolveInstructionFiles(patterns: string[] = INSTRUCTION_SOURCES): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*.md')) {
      const dir = pattern.slice(0, -'/*.md'.length);
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries.filter((e) => e.endsWith('.md')).sort()) {
        files.push(path.join(dir, entry));
      }
    } else if (fs.existsSync(pattern)) {
      files.push(pattern);
    }
  }
  return files;
}

/** Concatenate instruction files into a single AGENTS.md body. */
export function buildAgentsMd(parts: Array<{ path: string; content: string }>): string {
  return parts
    .filter((p) => p.content.trim())
    .map((p) => `<!-- ${p.path} -->\n\n${p.content.trimEnd()}\n`)
    .join('\n');
}

/** What one stream-json line means to the poll-loop. */
export interface KimiLineEffect {
  /** Live-status one-liners, already summarized. */
  progress: string[];
  /** Assistant prose emitted on this line, if any. */
  content?: string;
  /** Session id published by the trailing `meta` line. */
  sessionId?: string;
}

/**
 * Interpret one stdout line. Returns null for anything that isn't a JSON
 * object — tool output and status notices share this stream (see the file
 * header), so non-JSON is expected traffic, not an error.
 */
export function interpretStreamLine(line: string): KimiLineEffect | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const effect: KimiLineEffect = { progress: [] };

  if (parsed.role === 'meta' && typeof parsed.session_id === 'string') {
    effect.sessionId = parsed.session_id;
    return effect;
  }

  if (parsed.role === 'assistant') {
    const toolCalls = parsed.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = (call as { function?: { name?: string; arguments?: unknown } })?.function;
        if (!fn?.name) continue;
        let args: Record<string, unknown> = {};
        if (typeof fn.arguments === 'string') {
          try {
            args = JSON.parse(fn.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          args = fn.arguments as Record<string, unknown>;
        }
        effect.progress.push(summarizeToolUse(fn.name, args));
      }
    }
    if (typeof parsed.content === 'string' && parsed.content.trim()) {
      effect.content = parsed.content;
    }
  }

  return effect;
}

const SESSION_INVALID_RE = /session[_ ]?not[_ ]?found|SESSION_NOT_FOUND|no such session/i;

export class KimiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private memorySessionHook?: MemorySessionHookRegistration;
  /** Set once config.toml / mcp.json / AGENTS.md have been staged. */
  private homeStaged = false;
  private turnCounter = 0;

  constructor(private readonly options: ProviderOptions = {}) {}

  // kimi has no SessionStart hook. Shared memory is injected into the system
  // instructions of a FRESH session's first turn (no continuation), matching
  // the opencode and agy providers; a resumed session keeps its own context.
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    return SESSION_INVALID_RE.test(err instanceof Error ? err.message : String(err));
  }

  /**
   * Materialize KIMI_CODE_HOME: the operator's config with the group's
   * model/effort overlaid, the group's MCP servers, and the standing
   * instructions as AGENTS.md (the only instruction file kimi reads).
   */
  private stageHome(): void {
    if (this.homeStaged) return;
    try {
      fs.mkdirSync(KIMI_HOME, { recursive: true });

      let baseConfig = '';
      try {
        baseConfig = fs.readFileSync(BASE_CONFIG_PATH, 'utf-8');
      } catch {
        log(`no base config at ${BASE_CONFIG_PATH} — falling back to kimi's built-in defaults`);
      }
      fs.writeFileSync(
        path.join(KIMI_HOME, 'config.toml'),
        applyConfigOverrides(baseConfig, { model: this.options.model, effort: this.options.effort }),
      );

      fs.writeFileSync(
        path.join(KIMI_HOME, 'mcp.json'),
        JSON.stringify(mcpServersToKimiConfig(this.options.mcpServers), null, 2),
      );

      const files = resolveInstructionFiles();
      const parts = files.map((file) => {
        try {
          return { path: file, content: fs.readFileSync(file, 'utf-8') };
        } catch {
          return { path: file, content: '' };
        }
      });
      fs.writeFileSync(path.join(KIMI_HOME, 'AGENTS.md'), buildAgentsMd(parts));
      log(`staged home: ${files.length} instruction file(s), ${Object.keys(this.options.mcpServers ?? {}).length} MCP server(s)`);
    } catch (e) {
      log(`home staging failed: ${e}`);
    }
    this.homeStaged = true;
  }

  /**
   * Keep the prompt under the single-argument ceiling. Oversized prompts are
   * written into the session home and replaced by a pointer the model reads
   * with its own file tool.
   */
  private preparedPrompt(prompt: string): string {
    if (Buffer.byteLength(prompt, 'utf-8') <= MAX_PROMPT_ARG_BYTES) return prompt;
    const file = path.join(KIMI_HOME, 'prompts', `turn-${++this.turnCounter}.md`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, prompt);
      log(`prompt spilled to ${file} (${Buffer.byteLength(prompt, 'utf-8')} bytes exceeds the argv ceiling)`);
      return `Ta consigne pour ce tour est trop longue pour être passée en argument. Lis le fichier ${file} et traite son contenu comme le message qui t'est adressé.`;
    } catch (e) {
      log(`prompt spill failed (${e}) — truncating instead`);
      return prompt.slice(0, MAX_PROMPT_ARG_BYTES);
    }
  }

  query(input: QueryInput): AgentQuery {
    let aborted = false;
    let ended = false;
    let memoryInjected = false;
    let activeProc: ChildProcess | null = null;
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;

    const kick = () => waiting?.();
    const provider = this;
    const options = this.options;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let sessionId = input.continuation;
      let announcedSession: string | undefined;

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
        provider.stageHome();

        const memorySection =
          provider.memorySessionHook && !input.continuation && !memoryInjected
            ? memoryContextForSessionStart('startup')
            : undefined;
        if (memorySection) memoryInjected = true;
        const sysParts = [input.systemContext?.instructions, memorySection].filter(Boolean);
        const finalPrompt = provider.preparedPrompt(
          sysParts.length > 0 ? `<system_instructions>\n${sysParts.join('\n\n')}\n</system_instructions>\n\n${text}` : text,
        );

        const args = ['-p', finalPrompt, '--output-format', 'stream-json'];
        if (options.model) args.push('--model', options.model);
        if (sessionId) args.push('--session', sessionId);

        // detached: own process group, so abort() reaps kimi AND the stdio MCP
        // servers it spawned instead of orphaning them.
        activeProc = spawn('kimi', args, {
          cwd: input.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, KIMI_CODE_HOME: KIMI_HOME },
          detached: true,
        });

        const contents: string[] = [];
        const queue: ProviderEvent[] = [];
        let stderrTail = '';
        let finished = false;
        let spawnError: string | null = null;
        let wake: (() => void) | null = null;
        const push = (event: ProviderEvent) => {
          queue.push(event);
          wake?.();
        };

        // Without an 'error' listener a spawn failure (ENOENT on a missing
        // binary mount) emits an unhandled 'error' and takes down the runner.
        activeProc.on('error', (err) => {
          spawnError = err.message;
          finished = true;
          wake?.();
        });
        activeProc.stderr?.on('data', (d) => {
          stderrTail = (stderrTail + d.toString()).slice(-2000);
        });

        const rl = readline.createInterface({ input: activeProc.stdout! });
        rl.on('line', (line) => {
          const effect = interpretStreamLine(line);
          if (!effect) return;
          for (const message of effect.progress) push({ type: 'progress', message });
          if (effect.content) contents.push(effect.content);
          if (effect.sessionId) sessionId = effect.sessionId;
          push({ type: 'activity' });
        });

        let exitCode: number | null = null;
        activeProc.on('exit', (code) => {
          exitCode = code;
          finished = true;
          wake?.();
        });

        yield { type: 'activity' };

        while (!finished || queue.length > 0) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
        rl.close();

        // Aborted (!stop / !bg-cancel): drop the partial output rather than
        // delivering it right after the "⏹ Arrêté" acknowledgement.
        if (aborted) return;

        // The session id lands on the trailing meta line, so the continuation
        // can only be announced once the turn has drained.
        if (sessionId && sessionId !== announcedSession) {
          announcedSession = sessionId;
          yield { type: 'init', continuation: sessionId };
        }

        if (spawnError) {
          yield { type: 'error', message: `kimi spawn failed: ${spawnError}`, retryable: false };
          return;
        }

        const result = contents.join('\n\n').trim();
        if (exitCode !== 0 && !result) {
          yield {
            type: 'error',
            message: `kimi exited ${exitCode}: ${stderrTail.trim().slice(-500) || '(no stderr)'}`,
            retryable: false,
          };
          return;
        }

        // Every assistant line of the turn is kept, not just the last: a turn
        // that narrates before answering would otherwise lose the narration
        // (the truncation class already seen on the opencode provider).
        yield { type: 'result', text: result || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        if (activeProc?.pid) {
          try {
            process.kill(-activeProc.pid, 'SIGKILL');
          } catch {
            activeProc.kill('SIGKILL');
          }
        }
        kick();
      },
    };
  }
}

registerProvider('kimi', (opts) => new KimiProvider(opts));

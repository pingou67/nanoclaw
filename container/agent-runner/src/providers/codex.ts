import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';
import { archiveProviderExchange } from './exchange-archive.js';
import { summarizeToolUse } from './summarize.js';
import {
  type AppServer,
  type CodexMcpServer,
  type CodexMemorySessionHook,
  type CodexReasoningEffort,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  initializeCodexAppServer,
  interruptCodexTurn,
  killCodexAppServer,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  steerCodexTurn,
  writeCodexConfigToml,
} from './codex-app-server.js';

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_EFFORTS = new Set<CodexReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max', // GPT-5.6 (GA 2026-07-09) — voir CodexReasoningEffort
]);

export interface CodexRuntimeDeps {
  writeCodexConfigToml: typeof writeCodexConfigToml;
  spawnCodexAppServer: typeof spawnCodexAppServer;
  attachCodexAutoApproval: typeof attachCodexAutoApproval;
  initializeCodexAppServer: typeof initializeCodexAppServer;
  startOrResumeCodexThread: typeof startOrResumeCodexThread;
  startCodexTurn: typeof startCodexTurn;
  steerCodexTurn: typeof steerCodexTurn;
  interruptCodexTurn: typeof interruptCodexTurn;
  killCodexAppServer: typeof killCodexAppServer;
}

const defaultCodexRuntimeDeps: CodexRuntimeDeps = {
  writeCodexConfigToml,
  spawnCodexAppServer,
  attachCodexAutoApproval,
  initializeCodexAppServer,
  startOrResumeCodexThread,
  startCodexTurn,
  steerCodexTurn,
  interruptCodexTurn,
  killCodexAppServer,
};

function classifyError(message: string): string | undefined {
  if (/auth|api key|unauthorized|login|credential/i.test(message)) return 'auth';
  if (/quota|rate limit|insufficient|billing|credit/i.test(message)) return 'quota';
  if (/sandbox|permission|denied/i.test(message)) return 'sandbox';
  if (/thread|conversation|session/i.test(message)) return 'stale-session';
  return undefined;
}

function normalizeEffort(effort: string | undefined): CodexReasoningEffort | undefined {
  const normalized = effort?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!SUPPORTED_EFFORTS.has(normalized as CodexReasoningEffort)) {
    throw new Error(`Unsupported Codex reasoning effort: ${effort}`);
  }
  return normalized as CodexReasoningEffort;
}

/**
 * Items que codex émet et qui constituent une ACTION visible pour l'utilisateur.
 * `reasoning` et `agentMessage` en sont volontairement absents : ce sont le
 * modèle qui pense et qui parle, pas des outils. Les compter donnerait des
 * décomptes d'« actions » sans rapport avec ce que l'agent a fait.
 */
const ACTION_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Première clé présente dont la valeur est une chaîne non vide. */
function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  return undefined;
}

/**
 * Résume un item codex pour le post de statut, dans le MÊME format que claude
 * et opencode (`summarizeToolUse`), ou `null` si ce n'est pas une action.
 *
 * Volontairement défensif sur les noms de champs : le protocole app-server
 * n'est pas figé, et le pire cas doit rester un libellé générique mais juste
 * (`Bash`, `Edit`) — jamais un `[object Object]`, ni une action fantôme.
 */
export function summarizeCodexItem(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const type = typeof item.type === 'string' ? item.type : '';
  if (!ACTION_ITEM_TYPES.has(type)) return null;

  switch (type) {
    case 'commandExecution': {
      const command = firstString(item, ['command', 'commandLine', 'cmd']);
      return command ? summarizeToolUse('Bash', { command }) : 'Bash';
    }
    case 'fileChange': {
      const path = firstString(item, ['path', 'file_path', 'filePath']);
      return path ? summarizeToolUse('Edit', { path }) : 'Edit';
    }
    case 'mcpToolCall': {
      const name =
        [firstString(item, ['server', 'serverName']), firstString(item, ['tool', 'toolName', 'name'])]
          .filter(Boolean)
          .join('.') || 'MCP tool';
      const args = isRecord(item.arguments) ? item.arguments : isRecord(item.input) ? item.input : {};
      return summarizeToolUse(name, args);
    }
    default: {
      const query = firstString(item, ['query', 'q']);
      return query ? summarizeToolUse('Web search', { query }) : 'Web search';
    }
  }
}

/**
 * Traduit `McpServerConfig` vers les deux formes du config.toml de codex
 * (pendant de `toSdkMcpServers` dans claude.ts) : `url` pour un serveur
 * distant, `command`/`args`/`env` pour un stdio.
 *
 * Depuis l'adoption de l'union upstream (2026-08-11), plus AUCUN serveur ne peut
 * être écarté, et les deux gardes que portait cette fonction ont disparu avec
 * leur cause :
 *  - « ni command ni url » n'est plus représentable — le typage l'interdit ;
 *  - « en-têtes personnalisés » non plus : le modèle upstream n'a pas de champ
 *    `headers`. La limite de codex (uniquement `bearer_token_env_var`, jamais
 *    d'en-tête arbitraire) reste vraie, elle n'est simplement plus atteignable
 *    par la configuration. Si `headers` revenait un jour côté cœur, il faudrait
 *    RÉTABLIR le rejet nommé sur stderr : un MCP droppé en silence ne se voit
 *    que par des outils absents, mode de panne qui a coûté un long diagnostic
 *    sous kimi le 2026-07-28.
 */
export function toCodexMcpServers(
  servers: Record<string, McpServerConfig>,
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, CodexMcpServer> {
  const out: Record<string, CodexMcpServer> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === 'http') {
      out[name] = { url: cfg.url };
      continue;
    }
    // Le bloc `env` d'un serveur stdio REMPLACE l'environnement côté codex : il
    // n'hérite pas de celui du container. Sans réinjection, un serveur MCP perd
    // le proxy OneCLI et son CA, sort donc du périmètre de la passerelle — et
    // celui dont le secret est injecté dans un en-tête prend un 401. Il plante
    // au démarrage, codex l'écarte, et la panne ne se voit que par des outils
    // absents. Vécu le 2026-08-12 : vikunja muet sur dm/famille/work après la
    // bascule, et sur testor-codex depuis son installation le 2026-08-03.
    // Le `env` déclaré du groupe garde le dernier mot.
    const env = { ...inheritedNetworkEnv(parentEnv), ...(cfg.env ?? {}) };
    out[name] = {
      command: cfg.command,
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return out;
}

/**
 * Variables qui rattachent un processus enfant au proxy OneCLI et à son CA.
 * Même intention que `CODEX_ENV_ALLOWLIST` (codex-app-server.ts), appliquée
 * cette fois aux serveurs MCP que codex lance lui-même.
 */
const MCP_NETWORK_ENV_KEYS = [
  'ALL_PROXY',
  'CURL_CA_BUNDLE',
  'DENO_CERT',
  'GIT_SSL_CAINFO',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

function inheritedNetworkEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_NETWORK_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }
  return env;
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  // The app-server keeps history server-side; there is no on-disk transcript,
  // so the provider persists each exchange itself into `conversations/`
  // (see exchange-archive.ts). The poll-loop reports exchanges through this
  // hook and does nothing else — archiving is payload code, not runner code.
  onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({
      provider: 'codex',
      prompt: exchange.prompt,
      result: exchange.result,
      continuation: exchange.continuation,
      status: exchange.status,
    });
  }

  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly model?: string;
  private readonly effort?: CodexReasoningEffort;
  private readonly runtime: CodexRuntimeDeps;
  private memorySessionHook?: CodexMemorySessionHook;

  constructor(options: ProviderOptions = {}, runtime: CodexRuntimeDeps = defaultCodexRuntimeDeps) {
    this.mcpServers = options.mcpServers ?? {};
    this.model = options.model;
    this.runtime = runtime;
    this.effort = normalizeEffort(options.effort);
  }

  registerMemorySessionHook(hook: CodexMemorySessionHook): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Codex memory session hook was not registered');
    const memorySessionHook = this.memorySessionHook;
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let activeServer: AppServer | null = null;
    let activeThreadId: string | null = null;
    let activeTurnId: string | null = null;
    let wakeActiveTurn: (() => void) | null = null;

    const wake = (): void => {
      waiting?.();
      waiting = null;
    };

    const pushOrSteer = (message: string): void => {
      if (activeServer && activeThreadId && activeTurnId) {
        void this.runtime.steerCodexTurn(activeServer, activeThreadId, activeTurnId, message).catch(() => {
          pending.push(message);
          wake();
        });
        return;
      }
      pending.push(message);
      wake();
    };

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      self.runtime.writeCodexConfigToml(toCodexMcpServers(self.mcpServers), memorySessionHook, {
        model: self.model,
        effort: self.effort,
      });
      const server = self.runtime.spawnCodexAppServer();
      activeServer = server;
      self.runtime.attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;

      try {
        await self.runtime.initializeCodexAppServer(server);
        threadId = await self.runtime.startOrResumeCodexThread(server, threadId, {
          model: self.model,
          cwd: input.cwd,
          baseInstructions: input.systemContext?.instructions,
        });
        activeThreadId = threadId;

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;
          yield* runOneTurn(
            server,
            threadId,
            text,
            self.model,
            self.effort,
            input.cwd,
            (turnId) => {
              activeTurnId = turnId;
            },
            () => {
              activeTurnId = null;
            },
            () => initYielded,
            () => {
              initYielded = true;
            },
            () => aborted,
            (waker) => {
              wakeActiveTurn = waker;
            },
            self.runtime.startCodexTurn,
          );
        }
      } finally {
        activeTurnId = null;
        activeThreadId = null;
        activeServer = null;
        wakeActiveTurn = null;
        self.runtime.killCodexAppServer(server);
      }
    }

    return {
      push: pushOrSteer,
      end: () => {
        ended = true;
        wake();
      },
      abort: () => {
        aborted = true;
        if (activeServer && activeThreadId && activeTurnId) {
          void this.runtime.interruptCodexTurn(activeServer, activeThreadId, activeTurnId).catch(() => {});
        }
        wakeActiveTurn?.();
        wake();
      },
      events: gen(),
    };
  }
}

async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string | undefined,
  effort: string | undefined,
  cwd: string,
  setActiveTurn: (turnId: string) => void,
  clearActiveTurn: () => void,
  hasInit: () => boolean,
  markInit: () => void,
  isAborted: () => boolean,
  setAbortWaker: (waker: (() => void) | null) => void,
  startTurn: typeof startCodexTurn,
): AsyncGenerator<ProviderEvent> {
  const state: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;
  let turnId: string | null = null;

  // A finished turn can no longer absorb steered input: codex's turn/steer
  // against a completed turn resolves as a no-op, so a follow-up routed there
  // is lost silently. Clear the active-turn marker the moment the turn ends —
  // before the generator drains and tears down in its `finally` — so
  // pushOrSteer queues any racing follow-up into a fresh turn instead.
  const finishTurn = (): void => {
    turnDone = true;
    clearActiveTurn();
  };

  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };
  setAbortWaker(kick);

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params ?? {};
    buffer.push({ type: 'activity' });

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'turn/started': {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) {
          turnId = turn.id;
          setActiveTurn(turn.id);
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string | undefined;
        if (delta) resultText += delta;
        break;
      }
      case 'item/started': {
        // Les VRAIS outils passent par ici. Le poll-loop compte chaque
        // `progress` comme une action et l'affiche dans le post de statut :
        // n'émettre que pour un item qui est réellement une action.
        const summary = summarizeCodexItem(params.item);
        buffer.push(summary ? { type: 'progress', message: summary } : { type: 'activity' });
        break;
      }
      case 'item/completed': {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        break;
      }
      case 'thread/status/changed': {
        // Signal de LIVENESS, pas une action. L'émettre en `progress` faisait
        // deux choses fausses à la fois (vécu le 2026-08-03 sur un simple
        // « Hello ») : un post « 🔧 status: [object Object] » dans le canal —
        // `params.status` est un objet depuis 0.14x, pas une chaîne — et
        // surtout un décompte « 2 actions • 10s » pour un tour SANS le moindre
        // appel d'outil. `activity` est exactement fait pour ça : garder le
        // minuteur d'inactivité honnête sans rien afficher.
        buffer.push({ type: 'activity' });
        break;
      }
      case 'error': {
        const err = params.error as { message?: string; additionalDetails?: string | null } | undefined;
        const msg = [err?.message, err?.additionalDetails].filter(Boolean).join(': ') || 'Codex turn failed';
        state.error = new Error(msg);
        finishTurn();
        break;
      }
      case 'turn/completed': {
        const turn = params.turn as
          | { error?: { message?: string; additionalDetails?: string | null } | null; items?: unknown[] }
          | undefined;
        const agentMessage = turn?.items
          ?.filter((item): item is { type: string; text?: string } => typeof item === 'object' && item !== null)
          .find((item) => item.type === 'agentMessage' && item.text);
        if (agentMessage?.text) resultText = agentMessage.text;
        if (turn?.error) {
          const msg =
            [turn.error.message, turn.error.additionalDetails].filter(Boolean).join(': ') || 'Codex turn failed';
          state.error = new Error(msg);
        }
        finishTurn();
        break;
      }
      default:
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  // A dead app-server can't send the notification this turn is parked on —
  // end the turn immediately with the real cause instead of the 10-min timeout.
  const onServerExit = (err: Error): void => {
    if (turnDone) return;
    state.error = err;
    finishTurn();
    kick();
  };
  server.exitHandlers.push(onServerExit);

  const timer = setTimeout(() => {
    state.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    finishTurn();
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    turnId = await startTurn(server, {
      threadId,
      inputText,
      model,
      effort,
      cwd,
    });
    setActiveTurn(turnId);
    const imagesBefore = listGeneratedImages(threadId);
    if (isAborted()) return;

    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
      if (turnDone || isAborted()) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    if (isAborted()) return;

    if (state.error) {
      yield {
        type: 'error',
        message: state.error.message,
        retryable: false,
        classification: classifyError(state.error.message),
      };
      throw state.error;
    }

    for (const imagePath of listGeneratedImages(threadId)) {
      if (!imagesBefore.has(imagePath)) {
        yield { type: 'file', path: imagePath };
      }
    }

    yield { type: 'result', text: resultText || null };
  } finally {
    clearTimeout(timer);
    clearActiveTurn();
    setAbortWaker(null);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
    const exitIdx = server.exitHandlers.indexOf(onServerExit);
    if (exitIdx >= 0) server.exitHandlers.splice(exitIdx, 1);
  }
}

/**
 * Codex's built-in image generation saves into CODEX_HOME/generated_images/
 * <threadId>/ — its native client renders those to the user, so the model
 * believes delivery already happened and won't send_file them. The runner
 * must deliver them itself: snapshot the dir at turn start, emit a `file`
 * event for anything new at turn end.
 */
function listGeneratedImages(threadId: string): Set<string> {
  const dir = path.join(process.env.CODEX_HOME || '/home/node/.codex', 'generated_images', threadId);
  try {
    return new Set(fs.readdirSync(dir).map((f) => path.join(dir, f)));
  } catch {
    return new Set();
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));

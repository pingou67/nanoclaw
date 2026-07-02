import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { registerProvider } from './provider-registry.js';
import { summarizeToolUse } from './summarize.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[agy-provider] ${msg}`);
}

/**
 * Make agy's memory portable across providers.
 *
 * Antigravity persists learned facts to `<cwd>/.agents/AGENTS.md` (its native
 * memory/rules file). claude and opencode instead read+write
 * `<cwd>/CLAUDE.local.md`. Left alone, an agy group's memory would be invisible
 * to the other providers if the group is later switched — and vice versa.
 *
 * Fix: make `.agents/AGENTS.md` a symlink to `CLAUDE.local.md`. Antigravity
 * edits AGENTS.md in place (verified: the symlink survives writes), so agy ends
 * up reading/writing the SAME shared file as claude/opencode. Idempotent; folds
 * any pre-existing AGENTS.md content into CLAUDE.local.md once, then links.
 */
export function ensureMemoryLink(cwd: string): void {
  const claudeLocal = path.join(cwd, 'CLAUDE.local.md');
  const agentsDir = path.join(cwd, '.agents');
  const agentsMd = path.join(agentsDir, 'AGENTS.md');
  try {
    fs.mkdirSync(agentsDir, { recursive: true });
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(agentsMd); } catch { /* missing */ }
    if (st?.isSymbolicLink()) return; // already linked
    if (!fs.existsSync(claudeLocal)) fs.writeFileSync(claudeLocal, '');
    if (st?.isFile()) {
      // One-time migration: fold agy-written memory into the shared file.
      const prior = fs.readFileSync(agentsMd, 'utf-8');
      const shared = fs.readFileSync(claudeLocal, 'utf-8');
      if (prior.trim() && !shared.includes(prior.trim())) {
        const sep = shared && !shared.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(claudeLocal, shared + sep + prior.trimEnd() + '\n');
      }
      fs.unlinkSync(agentsMd);
    }
    fs.symlinkSync('../CLAUDE.local.md', agentsMd);
    log(`memory: linked .agents/AGENTS.md -> CLAUDE.local.md`);
  } catch (e) {
    log(`memory link setup failed: ${e}`);
  }
}

// Emulate a UUID generator for session IDs
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export class AgyProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private activeSessionId: string | undefined;
  // Set once the per-container MCP config has been staged (see query()).
  private mcpReady = false;
  // Set once the AGENTS.md -> CLAUDE.local.md memory link is in place.
  private memoryLinked = false;

  constructor(private readonly options: ProviderOptions = {}) {}

  isSessionInvalid(err: unknown): boolean {
    return false; // agy handles its own session integrity
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = generateUUID();
    }
    const sessionId = this.activeSessionId;

    let aborted = false;
    let ended = false;
    let activeProc: ChildProcess | null = null;
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;

    const kick = () => waiting?.();
    const options = this.options;
    const provider = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let isFirstPrompt = true;
      let resolvedSessionId = sessionId;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => { waiting = resolve; });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;

        // Share agy's memory file with claude/opencode (see ensureMemoryLink).
        if (!provider.memoryLinked) {
          ensureMemoryLink(input.cwd || '/workspace/agent');
          provider.memoryLinked = true;
        }

        let finalPrompt = text;
        if (input.systemContext?.instructions) {
          finalPrompt = `<system_instructions>\n${input.systemContext.instructions}\n</system_instructions>\n\n${text}`;
        }

        // List conversations directory before spawning to detect fallback ID creation
        const convDir = path.join(process.env.HOME || '/root', '.gemini', 'antigravity-cli', 'conversations');
        fs.mkdirSync(convDir, { recursive: true });
        const existingDbs = new Set(
          fs.existsSync(convDir) ? fs.readdirSync(convDir).filter(f => f.endsWith('.db')) : []
        );
        
        // We will spawn agy
        // Assuming agy is installed globally in the container
        const args = ['--prompt', finalPrompt, '--conversation', resolvedSessionId];
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.effort) {
          args.push('--effort', options.effort);
        }
        
        let spawnEnv: NodeJS.ProcessEnv = process.env;
        if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
          // Antigravity does NOT read a raw mcp.json — it loads MCP servers from
          // imported "plugins". To keep MCP servers ISOLATED PER CONTAINER (so
          // different agy groups don't share a single ~/.gemini/config), we run
          // agy under a container-local fake HOME (/tmp, isolated per Docker
          // container). The fake .gemini symlinks the real one's contents
          // (oauth token, conversations, brain, settings) EXCEPT config/
          // extensions, which stay container-local. The configured servers are
          // materialized as a Gemini-CLI extension, then `agy plugin import
          // gemini` stages them into the local config where the CLI reads them.
          // nanoclaw-only keys (e.g. `instructions`) are stripped — the
          // extension schema only knows command/args/env.
          const fakeHome = '/tmp/agy-mcp-home';
          const fakeGemini = path.join(fakeHome, '.gemini');
          const realGemini = path.join(process.env.HOME || '/root', '.gemini');
          if (!provider.mcpReady) {
            fs.mkdirSync(fakeGemini, { recursive: true });
            // Share everything except config/extensions with the real .gemini.
            if (fs.existsSync(realGemini)) {
              for (const item of fs.readdirSync(realGemini)) {
                if (item === 'config' || item === 'extensions') continue;
                const link = path.join(fakeGemini, item);
                if (!fs.existsSync(link)) {
                  try { fs.symlinkSync(path.join(realGemini, item), link); } catch (e) { /* ignore */ }
                }
              }
            }
            const cleanServers: Record<string, unknown> = {};
            for (const [name, cfg] of Object.entries(options.mcpServers)) {
              cleanServers[name] = { command: cfg.command, args: cfg.args, env: cfg.env };
            }
            const extDir = path.join(fakeGemini, 'extensions', 'nanoclaw-mcp');
            fs.mkdirSync(extDir, { recursive: true });
            fs.mkdirSync(path.join(fakeGemini, 'config'), { recursive: true });
            fs.writeFileSync(
              path.join(extDir, 'gemini-extension.json'),
              JSON.stringify({ name: 'nanoclaw-mcp', version: '1.0.0', mcpServers: cleanServers }, null, 2)
            );
            const imp = spawnSync('agy', ['plugin', 'import', 'gemini'], {
              encoding: 'utf-8',
              env: { ...process.env, HOME: fakeHome },
            });
            log(`mcp import: ${((imp.stdout || '') + (imp.stderr || '')).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
            provider.mcpReady = true;
          }
          spawnEnv = { ...process.env, HOME: fakeHome };
        }

        // rtk PATH shims — Antigravity's PreToolUse hook is decision-only
        // (allow/deny/ask, no tool-input rewrite), so rtk interception happens
        // at the shell level instead: /opt/rtk-shims shadows git/docker/… and
        // execs `rtk <cmd>` with a recursion guard. Prepend only for the agy
        // process tree so the rest of the agent-runner keeps a clean PATH.
        if (fs.existsSync('/opt/rtk-shims')) {
          spawnEnv = { ...spawnEnv, PATH: `/opt/rtk-shims:${spawnEnv.PATH ?? process.env.PATH ?? ''}` };
        }

        // Declared BEFORE the spawn so the 'error' listener below never hits
        // a temporal-dead-zone reference (spawn errors can fire during the
        // awaits of the session-id resolution block).
        let resultText = '';
        let lastContent = '';
        let rawBuffer = '';
        let processFinished = false;
        const progressQueue: string[] = [];
        let wakeProgress: (() => void) | null = null;

        // detached: own process group, so abort() can kill agy AND its
        // children (MCP stdio servers, plugin helpers) via process.kill(-pid)
        // instead of orphaning them.
        activeProc = spawn('agy', args, {
          cwd: input.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spawnEnv,
          detached: true,
        });
        // Without an 'error' listener a spawn failure (ENOENT, E2BIG on an
        // oversized --prompt argv) emits an unhandled 'error' event and
        // crashes the whole agent-runner mid-session.
        activeProc.on('error', (err) => {
          log(`agy spawn error: ${err.message}`);
          processFinished = true;
          wakeProgress?.();
        });

        // Resolve conversation ID if we had to fall back
        if (isFirstPrompt) {
          const targetDbFile = `${resolvedSessionId}.db`;
          if (!existingDbs.has(targetDbFile)) {
            // Poll for up to 5 seconds to find the newly created database file
            const startTime = Date.now();
            let found = false;
            while (Date.now() - startTime < 5000 && !found) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              try {
                const files = fs.readdirSync(convDir);
                const newDbs = files.filter(f => f.endsWith('.db') && !existingDbs.has(f));
                if (newDbs.length > 0) {
                  const newDb = newDbs[0];
                  resolvedSessionId = path.basename(newDb, '.db');
                  found = true;
                  log(`Resolved fallback session ID: ${resolvedSessionId}`);
                }
              } catch (err) {
                log(`Error reading conversations directory during fallback resolution: ${err}`);
              }
            }
          }

          // Yield the init event with the actual resolved session ID
          yield { type: 'init', continuation: resolvedSessionId };
          isFirstPrompt = false;
        }

        // Ensure brain dir exists for the resolved session ID so we can tail transcript.jsonl
        const brainDir = path.join(process.env.HOME || '/root', '.gemini', 'antigravity-cli', 'brain', resolvedSessionId);
        fs.mkdirSync(brainDir, { recursive: true });

        // transcript.jsonl is CUMULATIVE per conversation: on a continuation it
        // already holds every PRIOR turn's PLANNER_RESPONSE (content + tool_calls).
        // Start tailing from its current END so this turn doesn't replay old
        // tool_calls as live-status, nor surface a stale PLANNER_RESPONSE as its
        // result. A brand-new conversation has no transcript yet (offset 0).
        const transcriptCandidates = [
          path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl'),
          path.join(brainDir, 'transcript.jsonl'),
        ];
        let resolvedTranscriptFile: string | null = transcriptCandidates.find(p => fs.existsSync(p)) || null;
        let lastReadBytes = resolvedTranscriptFile ? fs.statSync(resolvedTranscriptFile).size : 0;

        activeProc!.stdout?.on('data', (d) => { resultText += d.toString(); });
        activeProc!.on('exit', () => {
          processFinished = true;
          wakeProgress?.();
        });

        // Tail transcript.jsonl for live progress updates
        const readTranscript = () => {
          if (!resolvedTranscriptFile) {
            resolvedTranscriptFile = transcriptCandidates.find(p => fs.existsSync(p)) || null;
            // Newly-appeared file: this turn owns all of it, read from the start.
            if (resolvedTranscriptFile) lastReadBytes = 0;
          }
          if (!resolvedTranscriptFile) return;

          let stat: fs.Stats;
          try {
            stat = fs.statSync(resolvedTranscriptFile);
          } catch {
            // agy rotated/removed the transcript mid-turn — an uncaught throw
            // inside the setInterval callback would crash the whole runner.
            // Forget the path; the next tick re-resolves the candidates.
            resolvedTranscriptFile = null;
            lastReadBytes = 0;
            return;
          }
          // Defensive: if agy rewrote/truncated the file, restart from the top.
          if (stat.size < lastReadBytes) lastReadBytes = 0;
          if (stat.size > lastReadBytes) {
            let buffer: Buffer;
            try {
              const fd = fs.openSync(resolvedTranscriptFile, 'r');
              buffer = Buffer.alloc(stat.size - lastReadBytes);
              fs.readSync(fd, buffer, 0, buffer.length, lastReadBytes);
              fs.closeSync(fd);
            } catch {
              return; // transient read failure — retry next tick
            }

            rawBuffer += buffer.toString('utf-8');
            lastReadBytes = stat.size;
            
            let newlineIdx;
            while ((newlineIdx = rawBuffer.indexOf('\n')) !== -1) {
              const line = rawBuffer.slice(0, newlineIdx);
              rawBuffer = rawBuffer.slice(newlineIdx + 1);
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'PLANNER_RESPONSE') {
                  if (entry.content) {
                    lastContent = entry.content;
                  }
                  if (entry.tool_calls && entry.tool_calls.length > 0) {
                    // Route through the shared summarizeToolUse helper so the
                    // live-status one-liner looks the SAME as the claude and
                    // opencode providers (e.g. `list_dir(DirectoryPath=…)`),
                    // not a cruder `Tool: <name>`.
                    for (const t of entry.tool_calls as Array<{ name: string; args?: Record<string, unknown> }>) {
                      progressQueue.push(summarizeToolUse(t.name, t.args ?? {}));
                    }
                    wakeProgress?.();
                  }
                }
              } catch (e) { /* ignore */ }
            }
          }
        };

        const tailInterval = setInterval(readTranscript, 500);

        yield { type: 'activity' };

        while (!processFinished || progressQueue.length > 0) {
          if (progressQueue.length > 0) {
            const msg = progressQueue.shift()!;
            yield { type: 'progress', message: msg };
            yield { type: 'activity' };
          } else {
            await new Promise<void>((resolve) => { wakeProgress = resolve; });
            wakeProgress = null;
          }
        }

        clearInterval(tailInterval);

        // Aborted (!stop / !bg-cancel): drop the partial output — yielding a
        // result here would deliver it to the channel right after the
        // "⏹ Arrêté" acknowledgement (and queue it as a bg result).
        if (aborted) return;
        readTranscript();

        // Use the explicit transcript content if available to avoid echoing history from stdout
        yield { type: 'result', text: lastContent || resultText || null };
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
          // Kill the whole process group (spawned detached) so agy's own
          // children (MCP stdio servers…) don't survive as orphans.
          try {
            process.kill(-activeProc.pid, 'SIGKILL');
          } catch {
            activeProc.kill('SIGKILL');
          }
        }
        kick();
      }
    };
  }
}

registerProvider('agy', (opts) => new AgyProvider(opts));

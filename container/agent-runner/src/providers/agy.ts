import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { registerProvider } from './provider-registry.js';
import { summarizeToolUse } from './summarize.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[agy-provider] ${msg}`);
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
        
        let spawnEnv = process.env;
        const realAgyDir = path.join(process.env.HOME || '/root', '.gemini', 'antigravity-cli');
        if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
          const fakeHome = path.join('/tmp', `agy-home-${resolvedSessionId}`);
          const fakeAgyDir = path.join(fakeHome, '.gemini', 'antigravity-cli');
          fs.mkdirSync(fakeAgyDir, { recursive: true });
          
          if (fs.existsSync(realAgyDir)) {
            for (const item of fs.readdirSync(realAgyDir)) {
              if (item !== 'mcp.json') {
                try { fs.symlinkSync(path.join(realAgyDir, item), path.join(fakeAgyDir, item)); } catch(e) {}
              }
            }
          }
          
          fs.writeFileSync(path.join(fakeAgyDir, 'mcp.json'), JSON.stringify({ mcpServers: options.mcpServers }));
          spawnEnv = { ...process.env, HOME: fakeHome };
        }

        activeProc = spawn('agy', args, {
          cwd: input.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spawnEnv
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

        let resultText = '';
        let lastContent = '';
        let lastReadBytes = 0;
        let rawBuffer = '';
        let processFinished = false;
        const progressQueue: string[] = [];
        let wakeProgress: (() => void) | null = null;

        activeProc!.stdout?.on('data', (d) => { resultText += d.toString(); });
        activeProc!.on('exit', () => {
          processFinished = true;
          wakeProgress?.();
        });

        // Tail transcript.jsonl for live progress updates
        let resolvedTranscriptFile: string | null = null;
        const readTranscript = () => {
          if (!resolvedTranscriptFile) {
            const possiblePaths = [
              path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl'),
              path.join(brainDir, 'transcript.jsonl'),
            ];
            resolvedTranscriptFile = possiblePaths.find(p => fs.existsSync(p)) || null;
          }
          if (!resolvedTranscriptFile) return;

          const stat = fs.statSync(resolvedTranscriptFile);
          if (stat.size > lastReadBytes) {
            const fd = fs.openSync(resolvedTranscriptFile, 'r');
            const buffer = Buffer.alloc(stat.size - lastReadBytes);
            fs.readSync(fd, buffer, 0, buffer.length, lastReadBytes);
            fs.closeSync(fd);
            
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
        if (activeProc) {
          activeProc.kill('SIGKILL');
        }
        kick();
      }
    };
  }
}

registerProvider('agy', (opts) => new AgyProvider(opts));

import { describe, expect, it } from 'bun:test';

import { CodexProvider } from './codex.js';

describe('CodexProvider', () => {
  it('rejects unsupported reasoning effort values', () => {
    expect(() => new CodexProvider({ effort: 'adaptive' })).toThrow(/Unsupported Codex reasoning effort/);
    expect(() => new CodexProvider({ effort: 'turbo' })).toThrow(/Unsupported Codex reasoning effort/);
  });

  it('normalizes supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'HIGH' })).toBeInstanceOf(CodexProvider);
  });

  it('accepts supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'xhigh' })).toBeInstanceOf(CodexProvider);
  });

  /**
   * Ce test affirmait l'INVERSE jusqu'au 2026-08-03 (`max` devait lever) : le
   * payload upstream est épinglé sur codex-cli 0.138.0, publiée un mois avant
   * la GA de GPT-5.6 qui a introduit ce palier. Nous tournons sur 0.146.0.
   *
   * `adaptive` reste refusé et le restera : codex n'a pas d'effort adaptatif —
   * on choisit un palier, il vaut pour tous les tours. L'équivalent claude
   * (`thinking: {type:'adaptive'}`) n'a pas de pendant ici.
   */
  it('accepte `max`, palier introduit par GPT-5.6', () => {
    expect(new CodexProvider({ effort: 'max' })).toBeInstanceOf(CodexProvider);
    expect(new CodexProvider({ effort: ' MAX ' })).toBeInstanceOf(CodexProvider);
  });

  it('requires the shared memory hook before starting a query', () => {
    expect(() => new CodexProvider({}).query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(/not registered/);
  });
});

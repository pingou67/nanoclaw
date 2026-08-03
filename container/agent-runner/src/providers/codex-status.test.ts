/**
 * Ce qui compte comme une « action » dans le post de statut en direct.
 *
 * Régression vécue le 2026-08-03 sur testor-codex : un simple « Hello », SANS
 * le moindre appel d'outil, produisait dans le canal
 * « 🔧 status: [object Object] » puis « ✅ Terminé en 10s, 2 actions ». Deux
 * fautes superposées — `thread/status/changed` traité comme un appel d'outil
 * (le poll-loop compte chaque `progress` comme une action), et `params.status`
 * lu comme une chaîne alors que c'est un objet depuis codex 0.14x.
 *
 * La règle que ces tests fixent : seul un item qui est vraiment un outil
 * compte. Penser et parler ne sont pas des actions.
 */
import { describe, expect, it } from 'bun:test';

import { summarizeCodexItem } from './codex.js';

describe('summarizeCodexItem', () => {
  it('ne compte NI le raisonnement NI le message de l’agent', () => {
    expect(summarizeCodexItem({ type: 'reasoning', text: 'hmm' })).toBeNull();
    expect(summarizeCodexItem({ type: 'agentMessage', text: 'Hello !' })).toBeNull();
  });

  it('ne compte pas un item inconnu ni une valeur non-objet', () => {
    expect(summarizeCodexItem({ type: 'somethingNew' })).toBeNull();
    expect(summarizeCodexItem(undefined)).toBeNull();
    expect(summarizeCodexItem('status')).toBeNull();
  });

  it('résume une commande au format partagé avec claude/opencode', () => {
    expect(summarizeCodexItem({ type: 'commandExecution', command: 'pnpm test' })).toBe('Bash(pnpm test)');
  });

  it('résume une modification de fichier', () => {
    expect(summarizeCodexItem({ type: 'fileChange', path: '/workspace/agent/notes.md' })).toBe(
      'Edit(/workspace/agent/notes.md)',
    );
  });

  it('résume un appel MCP avec serveur et outil', () => {
    expect(
      summarizeCodexItem({ type: 'mcpToolCall', server: 'vikunja', tool: 'list_projects', arguments: { id: '42' } }),
    ).toBe('vikunja.list_projects(id=42)');
  });

  it('résume une recherche web', () => {
    expect(summarizeCodexItem({ type: 'webSearch', query: 'météo Strasbourg' })).toBe('Web search("météo Strasbourg")');
  });

  it('dégrade en libellé générique quand les champs changent de nom — jamais [object Object]', () => {
    // Le protocole app-server n'est pas figé : le pire cas doit rester juste.
    for (const out of [
      summarizeCodexItem({ type: 'commandExecution', champInconnu: 'x' }),
      summarizeCodexItem({ type: 'fileChange' }),
      summarizeCodexItem({ type: 'webSearch' }),
      summarizeCodexItem({ type: 'mcpToolCall' }),
    ]) {
      expect(out).not.toBeNull();
      expect(out).not.toContain('[object Object]');
      expect(out).not.toContain('undefined');
    }
  });
});

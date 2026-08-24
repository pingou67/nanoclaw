#!/usr/bin/env tsx
/**
 * Audite le PÉRIMÈTRE des secrets injectés par OneCLI, c'est-à-dire la règle de
 * moindre exposition de CLAUDE.md § Secrets : « un secret n'est mis à
 * disposition que des groupes qui en ont un usage fonctionnel ».
 *
 * Pourquoi un script plutôt qu'une requête à la main : le périmètre se déclare
 * côté passerelle (`agents set-secrets`) tandis que le besoin se déclare côté
 * base (`container_configs.mcp_servers`). Ces deux moitiés dérivent en silence
 * — un groupe supprimé laisse son agent derrière lui, un serveur MCP retiré
 * laisse son assignation, un agent créé automatiquement naît en mode `all`.
 * Rien ne casse : le secret reste simplement joignable par un container qui n'a
 * plus de raison de l'atteindre. Seule une comparaison des deux côtés le voit.
 *
 *   pnpm exec tsx scripts/check-secret-scope.ts
 *
 * Sort en 1 dès qu'un écart est trouvé, pour être utilisable en vérification.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { OneCLI } from '@onecli-sh/sdk';
import Database from 'better-sqlite3';

import { ONECLI_API_KEY, ONECLI_URL } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AgentScope {
  /** Identifiant OneCLI (= id du groupe, `_` remplacés par `-`). */
  identifier: string;
  secretMode: string;
  /** Noms des secrets assignés (vide en mode `selective` sans assignation). */
  secrets: string[];
}

/** Besoin fonctionnel d'un groupe : les clés de ses serveurs MCP. */
export type GroupNeeds = Record<string, string[]>;

export interface ScopeFinding {
  level: 'écart' | 'info';
  message: string;
}

export interface AgentWithGrantSummary {
  identifier: string;
  grantsSummary: {
    mode: 'all' | 'grants';
    entries: Array<{ kind: 'app'; provider: string } | { kind: 'secret' | 'llm'; name: string }>;
  };
}

/** Convertit le modèle grants OneCLI 1.44+ vers le modèle neutre de l'audit. */
export function scopeFromGrantSummary(agent: AgentWithGrantSummary): AgentScope {
  return {
    identifier: agent.identifier,
    secretMode: agent.grantsSummary.mode === 'grants' ? 'selective' : 'all',
    secrets: agent.grantsSummary.entries
      .filter((entry): entry is { kind: 'secret' | 'llm'; name: string } => entry.kind !== 'app')
      .map((entry) => entry.name),
  };
}

/** `ag-mattermost_work` -> `ag-mattermost-work` (convention d'`ensureAgent`). */
export function identifierForGroup(groupId: string): string {
  return groupId.replace(/_/g, '-');
}

/**
 * Compare le périmètre déclaré côté passerelle au besoin déclaré côté base.
 *
 * `requiredBy` associe un nom de secret à la clé du serveur MCP qui le
 * consomme ; un secret sans `requiredBy` n'est pas auditable ici (on ne sait
 * pas ce qui le justifie) et n'est donc que signalé.
 */
export function auditScope(
  agents: AgentScope[],
  needs: GroupNeeds,
  requiredBy: Record<string, string | undefined>,
): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  const byIdentifier = new Map(Object.keys(needs).map((g) => [identifierForGroup(g), g]));

  for (const agent of agents) {
    const group = byIdentifier.get(agent.identifier);

    if (agent.secretMode !== 'selective') {
      findings.push({
        level: 'écart',
        message: `${agent.identifier} — mode « ${agent.secretMode} » : reçoit TOUT secret dont l'hôte correspond, sans déclaration de besoin.`,
      });
      continue;
    }

    if (!group) {
      // Agent de repli OneCLI, hors périmètre NanoClaw : ensureAgent crée une
      // identité dédiée par groupe. Son éventuel mode `all` a déjà été signalé.
      if (agent.identifier === 'default') continue;
      if (agent.secrets.length > 0) {
        findings.push({
          level: 'écart',
          message: `${agent.identifier} — agent orphelin (aucun groupe de ce nom) portant encore : ${agent.secrets.join(', ')}.`,
        });
      } else if (agent.identifier !== 'default') {
        findings.push({ level: 'info', message: `${agent.identifier} — agent orphelin, sans secret (inoffensif).` });
      }
      continue;
    }

    for (const name of agent.secrets) {
      const server = requiredBy[name];
      if (!server) {
        findings.push({
          level: 'info',
          message: `${agent.identifier} — porte « ${name} », dont le manifeste ne dit pas quel serveur MCP le consomme (non auditable).`,
        });
      } else if (!needs[group].includes(server)) {
        findings.push({
          level: 'écart',
          message: `${agent.identifier} — porte « ${name} » sans le serveur MCP « ${server} » qui le justifie.`,
        });
      }
    }

    // L'inverse : le besoin est déclaré mais l'injection ne suivra pas.
    for (const [name, server] of Object.entries(requiredBy)) {
      if (server && needs[group].includes(server) && !agent.secrets.includes(name)) {
        findings.push({
          level: 'écart',
          message: `${agent.identifier} — a le serveur MCP « ${server} » mais pas « ${name} » : les appels partiront sans credential (401).`,
        });
      }
    }
  }

  return findings;
}

async function collect(): Promise<{
  agents: AgentScope[];
  needs: GroupNeeds;
  requiredBy: Record<string, string | undefined>;
}> {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'vault-onecli-map.json'), 'utf-8'));
  const requiredBy: Record<string, string | undefined> = {};
  for (const [name, entry] of Object.entries(manifest as Record<string, { requiredBy?: string }>)) {
    if (name !== '//') requiredBy[name] = entry?.requiredBy;
  }

  const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
  const agents = (await onecli.listAgentsWithGrants()).map(scopeFromGrantSummary);

  const db = new Database(path.join(ROOT, 'data', 'v2.db'), { fileMustExist: true, readonly: true });
  const needs: GroupNeeds = {};
  for (const row of db.prepare('SELECT agent_group_id AS id, mcp_servers AS mcp FROM container_configs').all() as {
    id: string;
    mcp: string | null;
  }[]) {
    needs[row.id] = Object.keys(JSON.parse(row.mcp || '{}'));
  }
  db.close();

  return { agents, needs, requiredBy };
}

async function main(): Promise<void> {
  const { agents, needs, requiredBy } = await collect();
  const findings = auditScope(agents, needs, requiredBy);
  const gaps = findings.filter((f) => f.level === 'écart');

  for (const f of findings) console.log(`${f.level === 'écart' ? '✗' : 'ℹ'} ${f.message}`);
  if (gaps.length === 0) {
    console.log(`✓ Périmètre conforme — ${agents.length} agents, aucun secret hors usage fonctionnel.`);
  }
  process.exitCode = gaps.length > 0 ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

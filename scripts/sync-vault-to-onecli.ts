#!/usr/bin/env tsx
/**
 * Pousse vers OneCLI les secrets HTTP dont **Bitwarden est la source de
 * vérité** — la première branche de la doctrine secrets (CLAUDE.md § Secrets).
 *
 * Pourquoi cette indirection plutôt que de tout lire depuis le coffre au
 * spawn : pour un secret qui voyage dans un en-tête HTTP, OneCLI le réécrit à
 * la volée et **le container ne voit jamais la valeur**. C'est strictement
 * mieux qu'une variable d'environnement, qu'un agent peut lire et recopier.
 * Mais OneCLI devient alors un second dépôt de valeurs — donc on le traite en
 * simple CACHE d'injection, réalimenté depuis le coffre. Un seul endroit où
 * l'on édite un secret : Bitwarden.
 *
 *   pnpm exec tsx scripts/sync-vault-to-onecli.ts           # pousse
 *   pnpm exec tsx scripts/sync-vault-to-onecli.ts --check   # ne pousse rien
 *
 * Limite assumée : `onecli secrets list` n'expose ni la valeur ni une
 * empreinte stable, donc on ne peut PAS détecter une divergence sans écrire.
 * La synchro est one-way et idempotente par écrasement ; `--check` se borne à
 * vérifier que chaque référence est lisible et que le secret OneCLI existe.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { onecli, onecliJson } from './onecli-cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = path.join(ROOT, 'scripts', 'vault-onecli-map.json');

export interface MappingEntry {
  vaultRef: string;
  note?: string;
}

/** Charge le manifeste ; ignore la clé de commentaire et les entrées sans référence. */
export function loadMapping(raw: string): Record<string, MappingEntry> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, MappingEntry> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '//') continue;
    const entry = value as Partial<MappingEntry>;
    if (entry?.vaultRef) out[name] = { vaultRef: entry.vaultRef, note: entry.note };
  }
  return out;
}

/** `élément/champ` -> arguments `rbw get`. Sans champ : le mot de passe. */
export function rbwArgsFor(vaultRef: string): string[] {
  const slash = vaultRef.indexOf('/');
  return slash === -1 ? ['get', vaultRef] : ['get', vaultRef.slice(0, slash), '--field', vaultRef.slice(slash + 1)];
}

function rbw(args: string[]): string {
  const bin = process.env.RBW_BIN || path.join(os.homedir(), '.local', 'bin', 'rbw');
  return execFileSync(bin, args, { encoding: 'utf-8', timeout: 30_000 }).replace(/\r?\n$/, '');
}

interface OneCliSecret {
  id: string;
  name: string;
  hostPattern: string;
  injectionConfig: { headerName?: string; valueFormat?: string } | null;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const mapping = loadMapping(fs.readFileSync(MAP_PATH, 'utf-8'));
  const secrets = onecliJson<OneCliSecret>(['secrets', 'list']);
  const byName = new Map(secrets.map((s) => [s.name, s]));

  let problems = 0;
  for (const [name, entry] of Object.entries(mapping)) {
    const target = byName.get(name);
    if (!target) {
      console.error(`✗ ${name} — absent d'OneCLI. Le créer d'abord (secrets create + injectionConfig).`);
      problems++;
      continue;
    }
    if (!target.injectionConfig?.headerName) {
      // Piège vécu : `secrets create --header-name` ne pose PAS injectionConfig
      // (CLI 2.2.5). Sans lui le secret existe mais n'est jamais injecté.
      console.error(`✗ ${name} — injectionConfig absent : le secret ne sera JAMAIS injecté. Corriger avec secrets update --json.`);
      problems++;
      continue;
    }

    let value: string;
    try {
      value = rbw(rbwArgsFor(entry.vaultRef));
    } catch {
      console.error(`✗ ${name} — « ${entry.vaultRef} » illisible dans le coffre (verrouillé ou absent).`);
      problems++;
      continue;
    }
    if (!value) {
      console.error(`✗ ${name} — « ${entry.vaultRef} » est vide ; refus de pousser une valeur vide.`);
      problems++;
      continue;
    }

    if (check) {
      console.log(`✓ ${name} — coffre lisible (${value.length} c), cible ${target.hostPattern} prête`);
      continue;
    }
    onecli(['secrets', 'update', '--id', target.id, '--value', value]);
    console.log(`↑ ${name} — poussé depuis « ${entry.vaultRef} » vers ${target.hostPattern}`);
  }

  const orphans = secrets.filter((s) => !mapping[s.name]).map((s) => s.name);
  if (orphans.length) {
    console.log(`\nℹ Secrets OneCLI hors manifeste (valeur non gérée par le coffre) : ${orphans.join(', ')}`);
  }
  process.exitCode = problems > 0 ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

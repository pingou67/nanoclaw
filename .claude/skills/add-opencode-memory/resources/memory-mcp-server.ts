/**
 * Serveur MCP maison « memory » — mémoire persistante au format Claude Code.
 *
 * Expose les mêmes opérations que le plugin opencode `opencode-claude-memory`
 * (memory_save / memory_read / memory_list / memory_search / memory_delete,
 * plus memory_index) sur un répertoire de fichiers Markdown compatibles
 * Claude Code : un `MEMORY.md` d'index + un fichier par souvenir avec
 * frontmatter `name` / `description` / `type`. Un groupe qui pointe ce serveur
 * sur son `.claude-shared/projects/<slug>/memory/` partage donc sa mémoire
 * avec Claude Code et avec le plugin opencode sans aucune migration.
 *
 * Transport stdio via le SDK MCP officiel — utilisable par n'importe quel
 * provider (Claude Code, OpenCode, agy/Antigravity). Lancé en bun depuis
 * l'arbre agent-runner bind-monté (`/app/src/...`), il résout le SDK depuis
 * `/app/node_modules` relativement à ce fichier — aucune dépendance au cwd.
 *
 * Env :
 *  - `MEMORY_DIR` (requis) : répertoire absolu des fichiers mémoire, créé au
 *    besoin. Ex. `/home/node/.claude/projects/-workspace-group/memory`.
 *
 * Rien n'est jamais loggé sur stdout (réservé au protocole MCP).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

const MEMORY_DIR = process.env.MEMORY_DIR;
if (!MEMORY_DIR) {
  console.error('[memory-mcp] MEMORY_DIR env var is required');
  process.exit(1);
}

// Limites identiques à opencode-claude-memory / Claude Code (paths.ts).
const ENTRYPOINT_NAME = 'MEMORY.md';
const MAX_MEMORY_FILES = 200;
const MAX_MEMORY_FILE_BYTES = 40_000;
const FRONTMATTER_MAX_LINES = 30;
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

function memDir(): string {
  mkdirSync(MEMORY_DIR!, { recursive: true });
  return MEMORY_DIR!;
}

function entrypoint(): string {
  return join(memDir(), ENTRYPOINT_NAME);
}

// Mêmes règles que validateMemoryFileName du plugin.
function safeFileName(fileName: string): string {
  const withExt = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
  const base = withExt.slice(0, -3);
  if (base.length === 0) throw new Error('Memory file name cannot be empty');
  if (/[/\\]/.test(base)) throw new Error(`Memory file name must not contain path separators: ${fileName}`);
  if (base.includes('..')) throw new Error(`Memory file name must not contain path traversal: ${fileName}`);
  if (base.includes('\0')) throw new Error(`Memory file name must not contain null bytes: ${fileName}`);
  if (base.startsWith('.')) throw new Error(`Memory file name must not start with '.': ${fileName}`);
  if (base.toUpperCase() === 'MEMORY') throw new Error(`'${ENTRYPOINT_NAME}' is the reserved index file`);
  return withExt;
}

interface MemoryEntry {
  fileName: string;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('---')) return { frontmatter: {}, content: trimmed };
  const lines = trimmed.split('\n');
  let closing = -1;
  for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
    if (lines[i].trimEnd() === '---') { closing = i; break; }
  }
  if (closing === -1) return { frontmatter: {}, content: trimmed };
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) frontmatter[key] = value;
  }
  return { frontmatter, content: lines.slice(closing + 1).join('\n').trim() };
}

function readEntry(fileName: string): MemoryEntry | null {
  try {
    const raw = readFileSync(join(memDir(), fileName), 'utf-8');
    const { frontmatter, content } = parseFrontmatter(raw);
    const type = MEMORY_TYPES.find((t) => t === frontmatter.type) ?? 'user';
    return {
      fileName,
      name: frontmatter.name ?? fileName.replace(/\.md$/, ''),
      description: frontmatter.description ?? '',
      type,
      content,
    };
  } catch {
    return null;
  }
}

function listEntries(): MemoryEntry[] {
  let files: string[];
  try {
    files = readdirSync(memDir())
      .filter((f) => f.endsWith('.md') && f !== ENTRYPOINT_NAME)
      .sort()
      .slice(0, MAX_MEMORY_FILES);
  } catch {
    return [];
  }
  return files.map(readEntry).filter((e): e is MemoryEntry => e !== null);
}

function readIndex(): string {
  try {
    return readFileSync(entrypoint(), 'utf-8');
  } catch {
    return '';
  }
}

function updateIndex(fileName: string, name: string, description: string): void {
  const lines = readIndex().split('\n').filter((l) => l.trim());
  const pointer = `- [${name}](${fileName}) — ${description}`;
  const existing = lines.findIndex((l) => l.includes(`(${fileName})`));
  if (existing >= 0) lines[existing] = pointer;
  else lines.push(pointer);
  writeFileSync(entrypoint(), lines.join('\n') + '\n', 'utf-8');
}

function removeFromIndex(fileName: string): void {
  const lines = readIndex().split('\n').filter((l) => l.trim() && !l.includes(`(${fileName})`));
  writeFileSync(entrypoint(), lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8');
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

const server = new McpServer({ name: 'memory', version: '1.0.0' });

server.tool(
  'memory_index',
  "Lit l'index MEMORY.md (une ligne par souvenir). À consulter en début de conversation pour savoir ce dont tu te souviens.",
  {},
  async () => text(readIndex().trim() || '(mémoire vide)'),
);

server.tool(
  'memory_list',
  'Liste tous les souvenirs (fileName, name, description, type) sans leur contenu.',
  {},
  async () => {
    const entries = listEntries().map(({ fileName, name, description, type }) => ({ fileName, name, description, type }));
    return text(entries.length ? JSON.stringify(entries, null, 1) : '(mémoire vide)');
  },
);

server.tool(
  'memory_read',
  "Lit un souvenir complet par nom de fichier (ex. 'projet-x.md').",
  { fileName: z.string().describe("Nom du fichier mémoire, ex. 'projet-x.md'") },
  async ({ fileName }) => {
    const entry = readEntry(safeFileName(fileName));
    if (!entry) return text(`Souvenir introuvable : ${fileName}`);
    return text(JSON.stringify(entry, null, 1));
  },
);

server.tool(
  'memory_search',
  'Recherche plein-texte (insensible à la casse) dans les noms, descriptions et contenus des souvenirs.',
  { query: z.string().describe('Terme à chercher') },
  async ({ query }) => {
    const q = query.toLowerCase();
    const hits = listEntries()
      .filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.content.toLowerCase().includes(q))
      .map(({ fileName, name, description, type }) => ({ fileName, name, description, type }));
    return text(hits.length ? JSON.stringify(hits, null, 1) : `Aucun souvenir ne correspond à « ${query} »`);
  },
);

server.tool(
  'memory_save',
  "Crée ou met à jour un souvenir (un fichier Markdown + son entrée dans l'index MEMORY.md). Écrase le fichier s'il existe.",
  {
    fileName: z.string().describe("Nom de fichier kebab-case, ex. 'projet-x.md'"),
    name: z.string().describe('Titre court du souvenir'),
    description: z.string().describe("Résumé d'une ligne (sert d'index de rappel)"),
    type: z.enum(MEMORY_TYPES).describe('user | feedback | project | reference'),
    content: z.string().describe('Corps du souvenir en Markdown'),
  },
  async ({ fileName, name, description, type, content }) => {
    const safe = safeFileName(fileName);
    const fileContent = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${content.trim()}\n`;
    if (Buffer.byteLength(fileContent, 'utf-8') > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`);
    }
    writeFileSync(join(memDir(), safe), fileContent, 'utf-8');
    updateIndex(safe, name, description);
    return text(`Souvenir enregistré : ${safe}`);
  },
);

server.tool(
  'memory_delete',
  "Supprime un souvenir (fichier + entrée d'index).",
  { fileName: z.string().describe('Nom du fichier mémoire à supprimer') },
  async ({ fileName }) => {
    const safe = safeFileName(fileName);
    try {
      unlinkSync(join(memDir(), safe));
      removeFromIndex(safe);
      return text(`Souvenir supprimé : ${safe}`);
    } catch {
      return text(`Souvenir introuvable : ${safe}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[memory-mcp] ready — dir=${MEMORY_DIR}`);

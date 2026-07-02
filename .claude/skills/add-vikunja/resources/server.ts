/**
 * Serveur MCP maison pour Vikunja (https://vikunja.io) — gestion de tâches.
 *
 * Transport stdio standard via le SDK MCP officiel, donc utilisable tel quel par
 * n'importe quel client MCP : Claude Code, OpenCode, agy (Antigravity). Lancé en
 * bun depuis l'arbre agent-runner bind-monté (`/app/src/...`), il résout le SDK
 * depuis `/app/node_modules` relativement à ce fichier — aucune dépendance au cwd
 * ni au provider.
 *
 * Env :
 *  - `VIKUNJA_URL` (ex. https://vikunja.pegs.fr) et `VIKUNJA_TOKEN` (token d'API). Requis.
 *  - `VIKUNJA_DEFAULT_PROJECT_ID` : projet par défaut de create_task — **nom ou id**
 *    (ex. `FAMILLE` ou `4`). Défaut 1/Inbox.
 *  - `VIKUNJA_PROJECT_SCOPE` : cloisonnement, par **nom(s) ou id(s)**. Vide ou `ALL`
 *    = tous les projets ; `FAMILLE` (ou `4`) = un seul ; `WORK,PERSO` (ou `2,3`) =
 *    plusieurs. Noms insensibles à la casse, résolus au démarrage. Quand défini,
 *    TOUTES les opérations tâches/projets sont restreintes à ce périmètre (lecture
 *    comme écriture) : list filtré, et tout hors périmètre est refusé.
 *
 * Rien n'est jamais loggé sur stdout (réservé au protocole MCP) — diagnostics sur stderr.
 *
 * Couverture : tasks (CRUD, bulk, duplicate, filtres/recherche/tri), commentaires,
 * relations, labels (+ sur tâche), assignees, projets (CRUD, duplicate), filtres
 * sauvegardés, notifications & abonnements, pièces jointes (métadonnées), user.
 * Volontairement écarté (binaire/admin/niche) : upload/download de fichiers,
 * fonds Unsplash, buckets kanban & vues, équipes/partages, migration, webhooks,
 * réactions. Le cloisonnement porte sur les tâches/projets ; les métadonnées
 * globales de Vikunja (labels, filtres sauvegardés, notifications, user) ne sont
 * pas rattachées à un projet et restent globales.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.VIKUNJA_URL || '').replace(/\/$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN || '';
if (!BASE || !TOKEN) {
  console.error('[vikunja-mcp] VIKUNJA_URL / VIKUNJA_TOKEN manquants dans l\'env');
  process.exit(1);
}

type Query = Record<string, string | number | boolean | undefined | null>;

async function api(method: string, path: string, body?: unknown, query?: Query): Promise<unknown> {
  const url = new URL(BASE + '/api/v1' + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'message' in data && (data as { message: string }).message) || text;
    throw new Error(`HTTP ${res.status} ${method} ${path} — ${msg}`);
  }
  return data;
}

// ── Périmètre projet + projet par défaut : acceptent un NOM ou un id ──
// VIKUNJA_PROJECT_SCOPE : vide ou "ALL" = tous ; sinon un/plusieurs noms et/ou
// ids séparés par des virgules (ex. "FAMILLE", "WORK,PERSO", "2,3"). On résout
// les noms en ids au démarrage via la liste des projets (insensible à la casse).
const ALL_PROJECTS = (await api('GET', '/projects')) as Array<{ id: number; title: string }>;
const projById = new Map(ALL_PROJECTS.map((p) => [p.id, p.title] as const));
const projByName = new Map(ALL_PROJECTS.map((p) => [p.title.toLowerCase(), p.id] as const));
/** Résout un jeton (nom ou id) en id de projet existant, ou undefined. */
function resolveRef(tok: string): number | undefined {
  const t = tok.trim();
  if (/^\d+$/.test(t)) return projById.has(Number(t)) ? Number(t) : undefined;
  return projByName.get(t.toLowerCase());
}
function resolveScope(): Set<number> | null {
  const raw = process.env.VIKUNJA_PROJECT_SCOPE;
  if (!raw || raw.trim().toUpperCase() === 'ALL') return null;
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const id = resolveRef(tok);
    if (id !== undefined) ids.add(id);
    else unknown.push(tok);
  }
  if (unknown.length) console.error(`[vikunja-mcp] projet(s) introuvable(s) ignoré(s) dans VIKUNJA_PROJECT_SCOPE : ${unknown.join(', ')}`);
  if (ids.size === 0) {
    console.error('[vikunja-mcp] VIKUNJA_PROJECT_SCOPE ne résout aucun projet existant — arrêt.');
    process.exit(1);
  }
  return ids;
}
const SCOPE = resolveScope();
const scopeList = (): string => (SCOPE ? [...SCOPE].map((id) => `${projById.get(id) ?? '?'} (${id})`).join(', ') : 'tous');

/** Projet par défaut de create_task (nom ou id) ; ramené dans le périmètre si cloisonné. */
let DEFAULT_PROJECT = resolveRef(process.env.VIKUNJA_DEFAULT_PROJECT_ID || '1') ?? 1;
if (SCOPE && !SCOPE.has(DEFAULT_PROJECT)) DEFAULT_PROJECT = [...SCOPE][0];

const scopeErr = (what: string): Error => new Error(`${what} hors du périmètre autorisé pour ce canal (projet(s) ${scopeList()}).`);
/** Refuse un projet hors périmètre. */
function reqProject(id: number): void {
  if (SCOPE !== null && !SCOPE.has(id)) throw scopeErr(`Projet #${id}`);
}
/** Charge une tâche et refuse si son projet est hors périmètre. Renvoie la tâche. */
async function reqTask(id: number): Promise<{ project_id: number; assignees?: unknown[] }> {
  const t = (await api('GET', `/tasks/${id}`)) as { project_id: number; assignees?: unknown[] };
  if (SCOPE !== null && !SCOPE.has(t.project_id)) throw scopeErr(`Tâche #${id}`);
  return t;
}

/** Normalise une date : "YYYY-MM-DD" -> RFC3339 ; sinon passe tel quel. */
function normDate(d: string | undefined): string | undefined {
  if (!d) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T09:00:00Z' : d;
}
const hasDate = (d: unknown): d is string => typeof d === 'string' && !d.startsWith('0001');

function taskBody(a: Record<string, unknown>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  const passthrough = ['title', 'description', 'done', 'priority', 'percent_done', 'hex_color', 'repeat_after', 'repeat_mode', 'is_favorite', 'bucket_id'];
  for (const k of passthrough) if (a[k] !== undefined) b[k] = a[k];
  for (const k of ['due_date', 'start_date', 'end_date']) if (a[k] !== undefined) b[k] = normDate(a[k] as string);
  return b;
}

type Task = { id: number; title: string; done?: boolean; due_date?: string; priority?: number; project_id?: number };
function fmtTask(t: Task): string {
  const bits = [`#${t.id}`, t.done ? '[x]' : '[ ]', t.title];
  if (hasDate(t.due_date)) bits.push('— échéance ' + (t.due_date as string).slice(0, 10));
  if (t.priority) bits.push('— P' + t.priority);
  if (t.project_id) bits.push(`[proj ${t.project_id}]`);
  return bits.join(' ');
}

const server = new McpServer({ name: 'vikunja', version: '1.1.0' });

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
function reg(name: string, description: string, shape: z.ZodRawShape, fn: Handler): void {
  server.tool(name, description, shape, async (args: Record<string, unknown>) => {
    try {
      const r = await fn(args ?? {});
      const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
      return { content: [{ type: 'text' as const, text: text || '(ok)' }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: 'Erreur Vikunja : ' + (e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  });
}

// ─────────────────────────── Tasks ───────────────────────────
reg(
  'list_tasks',
  `Liste les tâches (périmètre : projet(s) ${scopeList()}), avec filtre/recherche/tri. Par défaut : non terminées, triées par échéance. Sortie lisible.`,
  {
    filter: z.string().optional().describe("Requête de filtre Vikunja, ex: 'done = false', 'priority >= 3', 'due_date < now+7d'. Défaut: done = false."),
    search: z.string().optional().describe('Recherche plein-texte dans le titre.'),
    sort_by: z.string().optional().describe('Champ de tri (due_date, priority, created, title…). Défaut: due_date.'),
    order_by: z.enum(['asc', 'desc']).optional(),
    page: z.number().optional(),
    per_page: z.number().optional().describe('Défaut 50.'),
    include_done: z.boolean().optional().describe('Si true, ne pas filtrer les terminées.'),
    raw: z.boolean().optional().describe('Si true, renvoie le JSON brut au lieu de la liste formatée.'),
  },
  async (a) => {
    let filter = (a.filter as string | undefined) ?? (a.include_done ? undefined : 'done = false');
    if (SCOPE) {
      const sf = `project in ${[...SCOPE].join(', ')}`;
      filter = filter ? `(${filter}) && ${sf}` : sf;
    }
    let tasks = (await api('GET', '/tasks', undefined, {
      filter,
      s: a.search as string | undefined,
      sort_by: (a.sort_by as string) ?? 'due_date',
      order_by: (a.order_by as string) ?? 'asc',
      page: a.page as number | undefined,
      per_page: (a.per_page as number) ?? 50,
    })) as Task[];
    if (!Array.isArray(tasks)) tasks = [];
    if (SCOPE) tasks = tasks.filter((t) => t.project_id !== undefined && SCOPE.has(t.project_id)); // ceinture + bretelles
    if (a.raw) return tasks;
    return tasks.length ? tasks.map(fmtTask).join('\n') : '(aucune tâche)';
  },
);

reg('get_task', "Détail complet d'une tâche (JSON).", { id: z.number() }, async (a) => {
  await reqTask(a.id as number);
  return api('GET', `/tasks/${a.id}`);
});

reg(
  'create_task',
  `Crée une tâche (projet par défaut de ce canal : ${DEFAULT_PROJECT} ; périmètre autorisé : ${scopeList()}).`,
  {
    title: z.string(),
    project_id: z.number().optional().describe(`Défaut ${DEFAULT_PROJECT}.`),
    description: z.string().optional(),
    due_date: z.string().optional().describe('RFC3339 ou YYYY-MM-DD.'),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    priority: z.number().min(0).max(5).optional(),
    percent_done: z.number().optional(),
    hex_color: z.string().optional(),
    repeat_after: z.number().optional().describe('Secondes entre répétitions.'),
    repeat_mode: z.number().optional().describe('0=par défaut, 1=mois, 2=à partir de la date.'),
  },
  (a) => {
    const pid = (a.project_id as number) ?? DEFAULT_PROJECT;
    reqProject(pid);
    return api('PUT', `/projects/${pid}/tasks`, { title: a.title, ...taskBody(a) });
  },
);

reg(
  'update_task',
  "Met à jour une tâche (n'importe quel champ : done, title, due_date, priority, percent_done, description…).",
  {
    id: z.number(),
    title: z.string().optional(),
    description: z.string().optional(),
    done: z.boolean().optional(),
    due_date: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    priority: z.number().min(0).max(5).optional(),
    percent_done: z.number().optional(),
    hex_color: z.string().optional(),
    is_favorite: z.boolean().optional(),
    repeat_after: z.number().optional(),
    repeat_mode: z.number().optional(),
  },
  async (a) => {
    await reqTask(a.id as number);
    return api('POST', `/tasks/${a.id}`, taskBody(a));
  },
);

reg('complete_task', 'Marque une tâche comme terminée.', { id: z.number() }, async (a) => {
  await reqTask(a.id as number);
  return api('POST', `/tasks/${a.id}`, { done: true });
});

reg('delete_task', 'Supprime une tâche.', { id: z.number() }, async (a) => {
  await reqTask(a.id as number);
  await api('DELETE', `/tasks/${a.id}`);
  return `Tâche #${a.id} supprimée.`;
});

reg(
  'bulk_update_tasks',
  'Met à jour plusieurs tâches en une fois (mêmes champs appliqués à tous les task_ids).',
  { task_ids: z.array(z.number()), fields: z.record(z.string(), z.unknown()).describe('Champs à appliquer, ex: {"done": true}.') },
  async (a) => {
    for (const id of a.task_ids as number[]) await reqTask(id);
    // Même allowlist que update_task (via taskBody) : sans elle, un `fields`
    // arbitraire pourrait poser project_id et déplacer des tâches hors du
    // périmètre du canal.
    const fields = a.fields as Record<string, unknown>;
    if (fields.project_id !== undefined) {
      throw new Error(`project_id n'est pas modifiable via bulk_update_tasks (périmètre : projet(s) ${scopeList()}) — utilise duplicate_task pour copier vers un autre projet du périmètre.`);
    }
    const body = taskBody(fields);
    const dropped = Object.keys(fields).filter((k) => !(k in body));
    if (dropped.length) console.error(`[vikunja-mcp] bulk_update_tasks : champ(s) hors allowlist ignoré(s) : ${dropped.join(', ')}`);
    return api('POST', '/tasks/bulk', { task_ids: a.task_ids, ...body });
  },
);

reg('duplicate_task', 'Duplique une tâche dans un projet cible.', { id: z.number(), project_id: z.number() }, async (a) => {
  await reqTask(a.id as number);
  reqProject(a.project_id as number);
  return api('PUT', `/tasks/${a.id}/duplicate`, { project_id: a.project_id });
});

// ─────────────────────────── Comments ───────────────────────────
reg('list_comments', "Liste les commentaires d'une tâche.", { task_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('GET', `/tasks/${a.task_id}/comments`);
});
reg('add_comment', 'Ajoute un commentaire à une tâche.', { task_id: z.number(), comment: z.string() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('PUT', `/tasks/${a.task_id}/comments`, { comment: a.comment });
});
reg('update_comment', 'Modifie un commentaire.', { task_id: z.number(), comment_id: z.number(), comment: z.string() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('POST', `/tasks/${a.task_id}/comments/${a.comment_id}`, { comment: a.comment });
});
reg('delete_comment', 'Supprime un commentaire.', { task_id: z.number(), comment_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  await api('DELETE', `/tasks/${a.task_id}/comments/${a.comment_id}`);
  return 'Commentaire supprimé.';
});

// ─────────────────────────── Relations ───────────────────────────
reg(
  'add_relation',
  'Crée une relation entre deux tâches. relation_kind: subtask, parenttask, related, duplicateof, duplicates, blocking, blocked, precedes, follows, copiedfrom, copiedto.',
  { task_id: z.number(), other_task_id: z.number(), relation_kind: z.string() },
  async (a) => {
    await reqTask(a.task_id as number);
    await reqTask(a.other_task_id as number);
    return api('PUT', `/tasks/${a.task_id}/relations`, { other_task_id: a.other_task_id, relation_kind: a.relation_kind });
  },
);
reg('remove_relation', 'Supprime une relation entre deux tâches.', { task_id: z.number(), relation_kind: z.string(), other_task_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  await api('DELETE', `/tasks/${a.task_id}/relations/${a.relation_kind}/${a.other_task_id}`);
  return 'Relation supprimée.';
});

// ─────────────────────────── Labels (globaux) ───────────────────────────
reg('list_labels', "Liste tous les labels de l'utilisateur (globaux, non rattachés à un projet).", {}, () => api('GET', '/labels'));
reg('create_label', 'Crée un label (global).', { title: z.string(), description: z.string().optional(), hex_color: z.string().optional() }, (a) =>
  api('PUT', '/labels', { title: a.title, description: a.description, hex_color: a.hex_color }),
);
reg('update_label', 'Modifie un label.', { id: z.number(), title: z.string().optional(), description: z.string().optional(), hex_color: z.string().optional() }, async (a) => {
  const cur = (await api('GET', `/labels/${a.id}`)) as Record<string, unknown>;
  return api('POST', `/labels/${a.id}`, { title: a.title ?? cur.title, description: a.description ?? cur.description, hex_color: a.hex_color ?? cur.hex_color });
});
reg('delete_label', 'Supprime un label.', { id: z.number() }, async (a) => {
  await api('DELETE', `/labels/${a.id}`);
  return `Label #${a.id} supprimé.`;
});
reg('list_task_labels', 'Liste les labels posés sur une tâche.', { task_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('GET', `/tasks/${a.task_id}/labels`);
});
reg('add_label_to_task', 'Ajoute un label à une tâche.', { task_id: z.number(), label_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('PUT', `/tasks/${a.task_id}/labels`, { label_id: a.label_id });
});
reg('remove_label_from_task', "Retire un label d'une tâche.", { task_id: z.number(), label_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  await api('DELETE', `/tasks/${a.task_id}/labels/${a.label_id}`);
  return 'Label retiré.';
});
reg('set_task_labels', "Remplace l'ensemble des labels d'une tâche.", { task_id: z.number(), label_ids: z.array(z.number()) }, async (a) => {
  await reqTask(a.task_id as number);
  return api('POST', `/tasks/${a.task_id}/labels/bulk`, { labels: (a.label_ids as number[]).map((id) => ({ id })) });
});

// ─────────────────────────── Assignees ───────────────────────────
reg('list_assignees', 'Liste les personnes assignées à une tâche.', { task_id: z.number() }, async (a) => {
  // L'endpoint dédié GET /tasks/{id}/assignees renvoie un 500 sur Vikunja v2.3.0 ;
  // on lit le champ `assignees` de la tâche (fiable, et passe par le contrôle de périmètre).
  const t = await reqTask(a.task_id as number);
  return t.assignees ?? [];
});
reg('add_assignee', 'Assigne un utilisateur à une tâche.', { task_id: z.number(), user_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('PUT', `/tasks/${a.task_id}/assignees`, { user_id: a.user_id });
});
reg('remove_assignee', "Retire un assigné d'une tâche.", { task_id: z.number(), user_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  await api('DELETE', `/tasks/${a.task_id}/assignees/${a.user_id}`);
  return 'Assigné retiré.';
});

// ─────────────────────────── Projects ───────────────────────────
reg('list_projects', 'Liste les projets accessibles (id + titre, restreint au périmètre).', { raw: z.boolean().optional() }, async (a) => {
  let ps = (await api('GET', '/projects')) as Array<{ id: number; title: string; is_archived?: boolean }>;
  if (SCOPE) ps = ps.filter((p) => SCOPE.has(p.id));
  if (a.raw) return ps;
  return ps.map((p) => `${p.id}\t${p.title}${p.is_archived ? ' (archivé)' : ''}`).join('\n') || '(aucun projet)';
});
reg('get_project', "Détail d'un projet.", { id: z.number() }, (a) => {
  reqProject(a.id as number);
  return api('GET', `/projects/${a.id}`);
});
reg('create_project', 'Crée un projet/liste.', { title: z.string(), description: z.string().optional(), parent_project_id: z.number().optional(), hex_color: z.string().optional() }, (a) => {
  if (SCOPE) throw scopeErr('Création de projet'); // un canal cloisonné ne crée pas de projet hors périmètre
  return api('PUT', '/projects', { title: a.title, description: a.description, parent_project_id: a.parent_project_id, hex_color: a.hex_color });
});
reg('update_project', 'Modifie un projet (le titre est conservé si non fourni).', { id: z.number(), title: z.string().optional(), description: z.string().optional(), is_archived: z.boolean().optional(), is_favorite: z.boolean().optional(), hex_color: z.string().optional() }, async (a) => {
  reqProject(a.id as number);
  const cur = (await api('GET', `/projects/${a.id}`)) as Record<string, unknown>;
  const b: Record<string, unknown> = { title: cur.title };
  for (const k of ['title', 'description', 'is_archived', 'is_favorite', 'hex_color']) if (a[k] !== undefined) b[k] = a[k];
  return api('POST', `/projects/${a.id}`, b);
});
reg('delete_project', 'Supprime un projet (et ses tâches).', { id: z.number() }, async (a) => {
  reqProject(a.id as number);
  await api('DELETE', `/projects/${a.id}`);
  return `Projet #${a.id} supprimé.`;
});
reg('duplicate_project', 'Duplique un projet.', { id: z.number(), parent_project_id: z.number().optional() }, (a) => {
  reqProject(a.id as number);
  if (SCOPE) throw scopeErr('Duplication de projet'); // créerait un nouveau projet hors périmètre
  return api('PUT', `/projects/${a.id}/duplicate`, { parent_project_id: a.parent_project_id ?? 0 });
});

// ─────────────────────────── Saved filters (globaux) ───────────────────────────
reg('create_filter', 'Crée un filtre sauvegardé (global).', { title: z.string(), filter: z.string().describe('Requête de filtre, ex: priority >= 4 && done = false'), description: z.string().optional() }, (a) =>
  api('PUT', '/filters', { title: a.title, description: a.description, filters: { filter: a.filter } }),
);
reg('get_filter', 'Récupère un filtre sauvegardé.', { id: z.number() }, (a) => api('GET', `/filters/${a.id}`));
reg('update_filter', 'Modifie un filtre sauvegardé.', { id: z.number(), title: z.string().optional(), filter: z.string().optional(), description: z.string().optional() }, async (a) => {
  const cur = (await api('GET', `/filters/${a.id}`)) as Record<string, unknown>;
  return api('POST', `/filters/${a.id}`, { title: a.title ?? cur.title, description: a.description ?? cur.description, filters: a.filter !== undefined ? { filter: a.filter } : cur.filters });
});
reg('delete_filter', 'Supprime un filtre sauvegardé.', { id: z.number() }, async (a) => {
  await api('DELETE', `/filters/${a.id}`);
  return `Filtre #${a.id} supprimé.`;
});

// ─────────────────────────── Notifications & subscriptions ───────────────────────────
reg('list_notifications', "Liste les notifications de l'utilisateur.", {}, () => api('GET', '/notifications'));
reg('mark_notification_read', 'Marque une notification comme lue/non-lue.', { id: z.number(), unread: z.boolean().optional() }, (a) =>
  api('POST', `/notifications/${a.id}`, { read: !(a.unread as boolean) }),
);
reg('subscribe', "S'abonne à une entité (entity: task|project). entity_id = son id.", { entity: z.enum(['task', 'project']), entity_id: z.number() }, async (a) => {
  if (a.entity === 'project') reqProject(a.entity_id as number);
  else await reqTask(a.entity_id as number);
  return api('PUT', `/subscriptions/${a.entity}/${a.entity_id}`, {});
});
reg('unsubscribe', "Se désabonne d'une entité.", { entity: z.enum(['task', 'project']), entity_id: z.number() }, async (a) => {
  if (a.entity === 'project') reqProject(a.entity_id as number);
  else await reqTask(a.entity_id as number);
  await api('DELETE', `/subscriptions/${a.entity}/${a.entity_id}`);
  return 'Désabonné.';
});

// ─────────────────────────── Attachments (métadonnées) & user ───────────────────────────
reg('list_attachments', "Liste les pièces jointes d'une tâche (métadonnées ; l'upload/download binaire n'est pas exposé).", { task_id: z.number() }, async (a) => {
  await reqTask(a.task_id as number);
  return api('GET', `/tasks/${a.task_id}/attachments`);
});
reg('get_current_user', "Infos de l'utilisateur courant (id, username, timezone…).", {}, () => api('GET', '/user'));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[vikunja-mcp] prêt (${BASE}) — périmètre projet(s) : ${scopeList()}, défaut : ${DEFAULT_PROJECT}`);

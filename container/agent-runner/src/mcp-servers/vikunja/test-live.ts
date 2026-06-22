/**
 * Harnais d'intégration pour le serveur MCP Vikunja — exerce CHAQUE tool contre
 * un vrai serveur, avec nettoyage. À lancer manuellement (pas en CI) :
 *
 *   docker run --rm -e VIKUNJA_URL=… -e VIKUNJA_TOKEN=… \
 *     -v "$PWD/container/agent-runner/src:/app/src:ro" -w / \
 *     --entrypoint bun <agent-image> run /app/src/mcp-servers/vikunja/test-live.ts
 *
 * Sort proprement (code 0) si VIKUNJA_URL/TOKEN absents.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.VIKUNJA_URL || !process.env.VIKUNJA_TOKEN) {
  console.log('VIKUNJA_URL/TOKEN absents — test sauté.');
  process.exit(0);
}

const transport = new StdioClientTransport({
  command: 'bun',
  args: ['run', '/app/src/mcp-servers/vikunja/server.ts'],
  env: process.env as Record<string, string>,
});
const client = new Client({ name: 'vikunja-test', version: '1.0.0' });
await client.connect(transport);

let pass = 0;
let fail = 0;
const created: { tasks: number[]; projects: number[]; labels: number[]; filters: number[] } = { tasks: [], projects: [], labels: [], filters: [] };

async function call(name: string, args?: Record<string, unknown>): Promise<unknown> {
  const r = (await client.callTool({ name, arguments: args ?? {} })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
let warn = 0;
async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + label);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + label + ' — ' + (e instanceof Error ? e.message : String(e)));
  }
}
/** Comme step, mais un 401/scope-token est un ⚠ non bloquant (limite du token, pas du code). */
async function stepSoft(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + label);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/401|invalid token|scope/i.test(m)) {
      warn++;
      console.log('  ⚠ ' + label + ' — scope token insuffisant (non bloquant)');
    } else {
      fail++;
      console.log('  ✗ ' + label + ' — ' + m);
    }
  }
}
const id = (o: unknown): number => (o as { id: number }).id;

// inventaire des tools
const tools = (await client.listTools()).tools;
console.log(`tools exposés : ${tools.length}`);
console.log(tools.map((t) => t.name).join(', '));
console.log('--- exercice ---');

let pid = 0;
let tid = 0;
let tid2 = 0;
let lid = 0;
let cid = 0;
let fid = 0;

await step('get_current_user', async () => {
  const u = await call('get_current_user');
  if (!id(u)) throw new Error('pas d\'id');
});
await step('list_projects', async () => {
  const t = (await call('list_projects')) as string;
  if (!/Inbox/.test(t)) throw new Error('Inbox absent');
});
await step('create_project', async () => {
  const p = await call('create_project', { title: '__MCP_TEST__', description: 'temp' });
  pid = id(p);
  created.projects.push(pid);
});
await step('get_project', async () => {
  const p = await call('get_project', { id: pid });
  if (id(p) !== pid) throw new Error('mismatch');
});
await step('update_project', async () => {
  await call('update_project', { id: pid, description: 'maj' });
});
await step('create_task', async () => {
  const t = await call('create_task', { title: '__t1__ test', project_id: pid, priority: 4, due_date: '2026-06-30' });
  tid = id(t);
  created.tasks.push(tid);
});
await step('get_task', async () => {
  const t = await call('get_task', { id: tid });
  if (id(t) !== tid) throw new Error('mismatch');
});
await step('update_task (percent + due)', async () => {
  await call('update_task', { id: tid, percent_done: 0.5, due_date: '2026-07-01T10:00:00Z' });
});
await step('list_tasks (formaté, contient la tâche)', async () => {
  const t = (await call('list_tasks', { filter: `project = ${pid}`, include_done: true })) as string;
  if (!t.includes('#' + tid)) throw new Error('tâche absente de la liste');
});
await step('list_tasks (raw)', async () => {
  const t = await call('list_tasks', { filter: `project = ${pid}`, raw: true, include_done: true });
  if (!Array.isArray(t)) throw new Error('pas un tableau');
});
await step('add_comment', async () => {
  const c = await call('add_comment', { task_id: tid, comment: 'coucou' });
  cid = id(c);
});
await step('list_comments', async () => {
  const c = (await call('list_comments', { task_id: tid })) as unknown[];
  if (!Array.isArray(c) || c.length < 1) throw new Error('vide');
});
await step('update_comment', async () => {
  await call('update_comment', { task_id: tid, comment_id: cid, comment: 'modifié' });
});
await step('delete_comment', async () => {
  await call('delete_comment', { task_id: tid, comment_id: cid });
});
await step('create_label', async () => {
  const l = await call('create_label', { title: '__MCP_LABEL__', hex_color: 'ff0000' });
  lid = id(l);
  created.labels.push(lid);
});
await step('list_labels', async () => {
  const l = (await call('list_labels')) as unknown[];
  if (!Array.isArray(l)) throw new Error('pas un tableau');
});
await step('update_label', async () => {
  await call('update_label', { id: lid, description: 'desc' });
});
await step('add_label_to_task', async () => {
  await call('add_label_to_task', { task_id: tid, label_id: lid });
});
await step('list_task_labels', async () => {
  const l = (await call('list_task_labels', { task_id: tid })) as unknown[];
  if (!Array.isArray(l) || l.length < 1) throw new Error('label absent');
});
await step('remove_label_from_task', async () => {
  await call('remove_label_from_task', { task_id: tid, label_id: lid });
});
await step('set_task_labels', async () => {
  await call('set_task_labels', { task_id: tid, label_ids: [lid] });
});
await step('list_assignees / add / remove (user 1)', async () => {
  await call('add_assignee', { task_id: tid, user_id: 1 });
  const a = (await call('list_assignees', { task_id: tid })) as unknown[];
  if (!Array.isArray(a) || a.length < 1) throw new Error('pas assigné');
  await call('remove_assignee', { task_id: tid, user_id: 1 });
});
await step('create 2e tâche + relation + remove', async () => {
  const t2 = await call('create_task', { title: '__t2__', project_id: pid });
  tid2 = id(t2);
  created.tasks.push(tid2);
  await call('add_relation', { task_id: tid, other_task_id: tid2, relation_kind: 'related' });
  await call('remove_relation', { task_id: tid, relation_kind: 'related', other_task_id: tid2 });
});
await step('complete_task', async () => {
  await call('complete_task', { id: tid });
});
await step('bulk_update_tasks (rouvrir les 2)', async () => {
  await call('bulk_update_tasks', { task_ids: [tid, tid2], fields: { done: false } });
});
await step('duplicate_task', async () => {
  const d = (await call('duplicate_task', { id: tid, project_id: pid })) as { duplicated_task?: { id: number } };
  if (d.duplicated_task?.id) created.tasks.push(d.duplicated_task.id);
});
await step('create_filter / get / update / delete', async () => {
  const f = await call('create_filter', { title: '__MCP_FILTER__', filter: 'done = false' });
  fid = id(f);
  await call('get_filter', { id: fid });
  await call('update_filter', { id: fid, description: 'x' });
  await call('delete_filter', { id: fid });
});
await step('list_notifications', async () => {
  await call('list_notifications');
});
await stepSoft('subscribe / unsubscribe (projet)', async () => {
  await call('subscribe', { entity: 'project', entity_id: pid });
  await call('unsubscribe', { entity: 'project', entity_id: pid });
});
await step('list_attachments (vide)', async () => {
  await call('list_attachments', { task_id: tid });
});
await step('duplicate_project', async () => {
  const d = (await call('duplicate_project', { id: pid })) as { duplicated_project?: { id: number } };
  if (d.duplicated_project?.id && d.duplicated_project.id !== pid) created.projects.push(d.duplicated_project.id);
});

// ─── nettoyage ───
console.log('--- nettoyage ---');
for (const t of created.tasks) await call('delete_task', { id: t }).catch(() => {});
for (const l of created.labels) await call('delete_label', { id: l }).catch(() => {});
for (const p of created.projects) await call('delete_project', { id: p }).catch(() => {});
// Balayage de sécurité : supprime tout artefact résiduel préfixé "__" (titres de
// test), au cas où un id aurait échappé au suivi — le test ne doit RIEN laisser.
const sweepTasks = (await call('list_tasks', { include_done: true, raw: true, per_page: 200 })) as Array<{ id: number; title: string }>;
let swept = 0;
for (const t of sweepTasks) if (/^__/.test(t.title)) { await call('delete_task', { id: t.id }).catch(() => {}); swept++; }
const sweepProjects = (await call('list_projects', { raw: true })) as Array<{ id: number; title: string }>;
for (const p of sweepProjects) if (/^__/.test(p.title)) { await call('delete_project', { id: p.id }).catch(() => {}); swept++; }
const sweepLabels = (await call('list_labels')) as Array<{ id: number; title: string }>;
for (const l of sweepLabels) if (/^__/.test(l.title)) { await call('delete_label', { id: l.id }).catch(() => {}); swept++; }
console.log(`nettoyé : ${created.tasks.length} tâches/${created.labels.length} labels/${created.projects.length} projets suivis + ${swept} résiduel(s) balayé(s)`);

console.log(`\n=== RÉSULTAT : ${pass} ✓ / ${fail} ✗ / ${warn} ⚠ ===`);
await client.close();
process.exit(fail ? 1 : 0);

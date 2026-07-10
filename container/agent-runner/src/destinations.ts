/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { openInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

// Lookups use short-lived openInboundDb() connections (open, query, close),
// NOT the getInboundDb() singleton: the host updates this table mid-session
// (see header), and the singleton's page cache can go stale on virtiofs
// mounts. Callers hit these at most a few times per message / per system
// prompt build, so a per-call open (microseconds) is negligible.

export function getAllDestinations(): DestinationEntry[] {
  const db = openInboundDb();
  try {
    const rows = db.prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
    return rows.map(rowToEntry);
  } finally {
    db.close();
  }
}

export function findByName(name: string): DestinationEntry | undefined {
  const db = openInboundDb();
  try {
    const row = db.prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
    return row ? rowToEntry(row) : undefined;
  } finally {
    db.close();
  }
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = openInboundDb();
  try {
    const row =
      channelType === 'agent'
        ? (db
            .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
            .get(platformId) as DestRow | undefined)
        : (db
            .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
            .get(channelType, platformId) as DestRow | undefined);
    return row ? rowToEntry(row) : undefined;
  } finally {
    db.close();
  }
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, structuredDelivery = false): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(structuredDelivery ? buildStructuredDestinationsSection() : buildDestinationsSection());

  return sections.join('\n\n');
}

/** Header + destination list shared by both delivery styles. */
function destinationListLines(): string[] {
  const all = getAllDestinations();
  if (all.length === 0) {
    return ['You currently have no configured destinations. You cannot send messages until an admin wires one up.'];
  }
  if (all.length === 1) {
    const d = all[0];
    return [`Your destination is \`${d.name}\`${destinationLabel(d)}.`];
  }
  const lines = ['You can send messages to the following destinations:', ''];
  for (const d of all) {
    lines.push(`- \`${d.name}\`${destinationLabel(d)}`);
  }
  return lines;
}

/**
 * Structured-delivery instructions (providers with `structuredDelivery`): the
 * agent's final reply text is delivered as-is to the conversation it is in, and
 * extra destinations go through the structured `send_message` tool. No XML
 * envelope — so no tool-call markup can bleed into a regex-parsed reply.
 */
function buildStructuredDestinationsSection(): string {
  const lines = ['## Sending messages', ''];
  lines.push(...destinationListLines());
  if (getAllDestinations().length === 0) return lines.join('\n');
  lines.push('');
  lines.push(
    'Just write your reply as your normal response text — it is delivered to the conversation you are replying in. Do NOT wrap it in any `<message>` tags.',
  );
  lines.push('');
  lines.push(
    'To message a *different* destination (or several), call the `send_message` tool with `to` (destination name) and `text`. Use one call per destination. It also works mid-turn for a quick acknowledgment ("on it") before a slow tool call. Each call lands as its own message.',
  );
  lines.push('');
  lines.push('Wrap any private reasoning you do NOT want delivered in `<internal>…</internal>`.');
  return lines.join('\n');
}

function buildDestinationsSection(): string {
  const lines = ['## Sending messages', ''];
  lines.push(...destinationListLines());
  if (getAllDestinations().length === 0) return lines.join('\n');
  lines.push('');
  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn — handy for a quick acknowledgment ("on it") before a slow tool call. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.',
  );
  return lines.join('\n');
}

function destinationLabel(d: DestinationEntry): string {
  const parts: string[] = [];
  if (d.channelType) parts.push(d.channelType);
  if (d.displayName && d.displayName !== d.name) parts.push(d.displayName);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/**
 * Render a one-line summary of a tool call for the live status post. Picks
 * the most informative arg per tool family — file path for Read/Write/Edit,
 * command for Bash, query for search tools, etc. Falls back to a generic
 * `name(arg=value)` representation when the tool isn't specifically handled.
 *
 * Shared between claude and opencode providers so the user sees the same
 * status format regardless of which agent runner is driving the session.
 */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 60): string => {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  };
  // File-path tools
  if (typeof input.file_path === 'string') return `${name}(${s(input.file_path, 80)})`;
  if (typeof input.path === 'string') return `${name}(${s(input.path, 80)})`;
  // Bash
  if (name === 'Bash' && typeof input.command === 'string') return `Bash(${s(input.command, 80)})`;
  // Common search/query tools
  if (typeof input.query === 'string') return `${name}("${s(input.query, 50)}")`;
  if (typeof input.pattern === 'string') return `${name}(/${s(input.pattern, 50)}/)`;
  // MCP tools — extract the first string arg with a useful key
  for (const key of ['folder', 'mailbox', 'url', 'description', 'name', 'id', 'subject', 'to']) {
    if (typeof input[key] === 'string') return `${name}(${key}=${s(input[key], 50)})`;
  }
  // Fallback — show the first arg or just the tool name
  const firstKey = Object.keys(input)[0];
  if (firstKey) return `${name}(${firstKey}=${s(input[firstKey], 40)})`;
  return name;
}

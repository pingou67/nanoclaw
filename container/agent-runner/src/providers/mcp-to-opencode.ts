import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/**
 * Map NanoClaw v2 MCP definitions (same shape as Claude Agent SDK) into
 * OpenCode config `mcp` field. Stdio entries become `local`, url-based
 * entries (`type: 'http' | 'sse'`) become `remote`.
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    // Discrimination sur `type` depuis l'union upstream (2026-08-11) ;
    // `headers` a disparu du modèle, aucun de nos serveurs n'en portait.
    if (cfg.type === 'http') {
      out[name] = {
        type: 'remote',
        url: cfg.url,
        enabled: true,
      };
    } else if (cfg.command) {
      out[name] = {
        type: 'local',
        command: [cfg.command, ...(cfg.args ?? [])],
        ...(cfg.env && Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
        enabled: true,
      };
    }
  }
  return out;
}

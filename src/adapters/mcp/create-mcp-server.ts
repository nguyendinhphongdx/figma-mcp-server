import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Principal } from '../../core/security/api-keys.js';
import type { Logger } from '../../infra/logger.js';
import { registerTools, type UseCases } from './tools.js';

export const SERVER_INFO = { name: 'figma-mcp-server', version: '0.1.0' } as const;

const INSTRUCTIONS = [
  'Read-only access to Figma plus bulk image export, shared by a team through one Figma token.',
  'The Figma API budget is small and shared: batch node ids into one call, reuse cached results,',
  'check figma_quota_status before big operations, and never retry a rate-limited call before its retryAfterSeconds.',
  'Typical flow: figma_list_frames -> pick node ids -> figma_export_frames (or figma_get_node_tree for details).',
].join(' ');

/**
 * Builds an MCP server for one request. The server is stateless and cheap, so creating it per
 * request lets tool handlers close over the authenticated principal without any shared mutable state.
 */
export function createMcpServer(useCases: UseCases, principal: Principal, logger: Logger): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server, useCases, { principal, logger });
  return server;
}

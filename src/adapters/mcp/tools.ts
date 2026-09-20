import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IMAGE_FORMATS } from '../../core/figma/figma-api.js';
import type { ExportFramesUseCase } from '../../features/export/export-frames.js';
import type { ListFramesUseCase } from '../../features/frames/list-frames.js';
import type { GetNodeTreeUseCase } from '../../features/nodes/get-node-tree.js';
import type { ListLibraryUseCase } from '../../features/library/list-library.js';
import type { GetDesignTokensUseCase } from '../../features/tokens/design-tokens.js';
import type { GetCommentsUseCase } from '../../features/comments/get-comments.js';
import type { GetQuotaStatusUseCase } from '../../features/quota/get-quota-status.js';
import { runTool, type ToolContext } from './tool-helpers.js';

/** Everything the MCP adapter needs from the application layer. */
export interface UseCases {
  readonly listFrames: ListFramesUseCase;
  readonly getNodeTree: GetNodeTreeUseCase;
  readonly exportFrames: ExportFramesUseCase;
  readonly listStyles: ListLibraryUseCase;
  readonly listComponents: ListLibraryUseCase;
  readonly getDesignTokens: GetDesignTokensUseCase;
  readonly getComments: GetCommentsUseCase;
  readonly getQuotaStatus: GetQuotaStatusUseCase;
}

const file = z.string().min(1).describe('Figma file URL (any link into the file) or file key.');
const refresh = z
  .boolean()
  .optional()
  .describe('Bypass the server cache and re-read from Figma. Spends shared Figma request budget; only use when the data is known to be stale.');

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true } as const;

/** Registers every tool. Tool text is written for a model: it states what each call costs. */
export function registerTools(server: McpServer, useCases: UseCases, context: ToolContext): void {
  server.registerTool(
    'figma_list_frames',
    {
      title: 'List Figma pages and frames',
      description:
        'List the pages of a Figma file and their top-level frames/sections/components (id, name, size). ' +
        'Start here to find node ids to export or inspect. Costs 1 Tier-1 Figma request on a cold cache, free afterwards ' +
        '(the result is cached and shared by the whole team). Also makes later exports name files after layers for free.',
      inputSchema: {
        file,
        page: z.string().optional().describe('Only pages whose name contains this text (case-insensitive).'),
        types: z
          .array(z.string())
          .optional()
          .describe('Node types to keep. Default: FRAME, SECTION, COMPONENT, COMPONENT_SET.'),
        refresh,
      },
      annotations: { title: 'List Figma pages and frames', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_list_frames', () => useCases.listFrames.execute(args)),
  );

  server.registerTool(
    'figma_get_node_tree',
    {
      title: 'Read a Figma layer tree',
      description:
        'Read the layer tree under specific nodes: names, types, bounds, text and, on request, layout and style details. ' +
        'All ids go into one batched Tier-1 request (cached). Output is trimmed and capped by maxNodes; ' +
        'if `truncated` is true, call again with a smaller subtree or higher maxNodes.',
      inputSchema: {
        ids: z.array(z.string()).min(1).max(50).describe('Node ids ("12:34" or "12-34") or Figma frame links.'),
        file: file.optional().describe('Figma file URL or key. Optional when ids are full Figma links.'),
        depth: z.number().int().min(1).max(10).optional().describe('Levels of children to read. Default 2.'),
        include: z
          .array(z.enum(['layout', 'style', 'text']))
          .optional()
          .describe('Extra detail: layout (auto-layout, padding), style (fills, strokes, effects, radius), text (font details).'),
        maxNodes: z.number().int().min(1).max(2000).optional().describe('Cap on returned nodes. Default 500.'),
        refresh,
      },
      annotations: { title: 'Read a Figma layer tree', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_get_node_tree', () => useCases.getNodeTree.execute(args)),
  );

  server.registerTool(
    'figma_export_frames',
    {
      title: 'Export Figma frames as images',
      description:
        'Export many frames/nodes as images (jpg, png, svg, pdf). Files are stored on the server and returned as time-limited ' +
        'download links (plus one zip link); nothing is sent inline. ALL nodes are batched into as few Figma requests as ' +
        'possible and image URLs are cached, so exporting the same frames again costs zero Figma requests. ' +
        'Pass every node in ONE call rather than one call per frame. If Figma rate-limits the run, the result is partial ' +
        'and `rateLimited` says when to retry.',
      inputSchema: {
        nodes: z.array(z.string()).min(1).max(1000).describe('Node ids ("12:34" or "12-34") or Figma frame links.'),
        file: file.optional().describe('Figma file URL or key. Optional when nodes are full Figma links.'),
        format: z.enum(IMAGE_FORMATS as unknown as [string, ...string[]]).optional().describe('Default jpg.'),
        scale: z.number().min(0.01).max(4).optional().describe('Render scale for jpg/png. Default 2.'),
        useAbsoluteBounds: z.boolean().optional().describe('Export the full node bounds without cropping.'),
        useLayerNames: z.boolean().optional().describe('Name files after layer names. Default true.'),
        createArchive: z.boolean().optional().describe('Also return a zip of all files. Default true.'),
        refresh,
      },
      annotations: { title: 'Export Figma frames as images', readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      runTool(context, 'figma_export_frames', () =>
        useCases.exportFrames.execute({ ...args, format: args.format as (typeof IMAGE_FORMATS)[number] | undefined }),
      ),
  );

  server.registerTool(
    'figma_list_styles',
    {
      title: 'List Figma styles',
      description:
        'List the published styles of a file (colour, text, effect, grid) with their node ids. 1 Tier-3 request, cached. ' +
        'For ready-to-use values call figma_get_design_tokens instead.',
      inputSchema: {
        file,
        styleType: z.enum(['FILL', 'TEXT', 'EFFECT', 'GRID']).optional(),
        query: z.string().optional().describe('Only styles whose name contains this text.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200.'),
        refresh,
      },
      annotations: { title: 'List Figma styles', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_list_styles', () => useCases.listStyles.execute(args)),
  );

  server.registerTool(
    'figma_list_components',
    {
      title: 'List Figma components',
      description:
        'List the published components of a file with their node ids and the frame/page they live in. 1 Tier-3 request, cached. ' +
        'Only works on the main file, not on branches.',
      inputSchema: {
        file,
        query: z.string().optional().describe('Only components whose name contains this text.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200.'),
        refresh,
      },
      annotations: { title: 'List Figma components', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_list_components', () => useCases.listComponents.execute(args)),
  );

  server.registerTool(
    'figma_get_design_tokens',
    {
      title: 'Extract design tokens',
      description:
        'Turn the file\'s published styles into design tokens: colours (hex/gradients), typography (family, weight, size, line height) ' +
        'and shadows, optionally as CSS custom properties. Cost on a cold cache: 1 Tier-3 request plus one Tier-1 request per 100 styles; ' +
        'free afterwards. Figma Variables are not included.',
      inputSchema: {
        file,
        format: z.enum(['json', 'css']).optional().describe('`css` adds a ready-to-paste :root block. Default json.'),
        refresh,
      },
      annotations: { title: 'Extract design tokens', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_get_design_tokens', () => useCases.getDesignTokens.execute(args)),
  );

  server.registerTool(
    'figma_get_comments',
    {
      title: 'Read Figma comments',
      description:
        'Read comment threads of a file, newest first, with replies, resolved state and the node each thread is pinned to. ' +
        '1 Tier-2 request, cached for a couple of minutes.',
      inputSchema: {
        file,
        status: z.enum(['all', 'open', 'resolved']).optional().describe('Default all.'),
        nodeId: z.string().optional().describe('Only threads pinned to this node.'),
        limit: z.number().int().min(1).max(200).optional().describe('Threads to return. Default 50.'),
        refresh,
      },
      annotations: { title: 'Read Figma comments', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_get_comments', () => useCases.getComments.execute(args)),
  );

  server.registerTool(
    'figma_quota_status',
    {
      title: 'Figma request budget status',
      description:
        'Show the shared Figma request budget per tier: requests used in the last hour, free slots right now, and whether Figma ' +
        'is currently rate-limiting (with when it lifts). Costs nothing. Check it before large or repeated operations.',
      inputSchema: {},
      annotations: { title: 'Figma request budget status', readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => runTool(context, 'figma_quota_status', async () => useCases.getQuotaStatus.execute()),
  );
}

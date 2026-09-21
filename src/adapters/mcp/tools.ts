import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IMAGE_FORMATS } from '../../core/figma/figma-api.js';
import type { ExportFramesUseCase } from '../../features/export/export-frames.js';
import type { GetSvgUseCase } from '../../features/export/get-svg.js';
import type { ListFramesUseCase } from '../../features/frames/list-frames.js';
import type { GetNodeTreeUseCase } from '../../features/nodes/get-node-tree.js';
import type { GetNodeSpecUseCase } from '../../features/nodes/get-node-spec.js';
import type { SearchNodesUseCase } from '../../features/search/search-nodes.js';
import type { ListLibraryUseCase } from '../../features/library/list-library.js';
import type { GetDesignTokensUseCase } from '../../features/tokens/design-tokens.js';
import type { GetCommentsUseCase } from '../../features/comments/get-comments.js';
import type { GetQuotaStatusUseCase } from '../../features/quota/get-quota-status.js';
import { runMediaTool, runTool, type ToolContext } from './tool-helpers.js';

/** Everything the MCP adapter needs from the application layer. */
export interface UseCases {
  readonly listFrames: ListFramesUseCase;
  readonly searchNodes: SearchNodesUseCase;
  readonly getNodeTree: GetNodeTreeUseCase;
  readonly getNodeSpec: GetNodeSpecUseCase;
  readonly exportFrames: ExportFramesUseCase;
  readonly getSvg: GetSvgUseCase;
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
        '(the result is cached and shared by the whole team). Also makes later exports name files after layers for free. ' +
        'Large files run to thousands of frames: results are paged (default 200), and `hasMore` says there are more. ' +
        'If you already know roughly what the layer is called, figma_search_nodes is smaller and cheaper than paging through this.',
      inputSchema: {
        file,
        page: z.string().optional().describe('Only pages whose name contains this text (case-insensitive).'),
        types: z
          .array(z.string())
          .optional()
          .describe('Node types to keep. Default: FRAME, SECTION, COMPONENT, COMPONENT_SET.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Nodes to return across all pages. Default 200.'),
        offset: z.number().int().min(0).optional().describe('Nodes to skip, for paging. Default 0.'),
        refresh,
      },
      annotations: { title: 'List Figma pages and frames', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_list_frames', () => useCases.listFrames.execute(args)),
  );

  server.registerTool(
    'figma_search_nodes',
    {
      title: 'Find Figma layers by name',
      description:
        'Find layers whose name matches a query, and get back their node ids, type, page and path. ' +
        'Matching ignores case and Vietnamese diacritics, so "truong ban" finds "Trường bắn". ' +
        'By default it searches the top level of every page and costs nothing once any tool has read the file ' +
        '(it reuses the same cached outline as figma_list_frames). Prefer it over paging through figma_list_frames ' +
        'when you know what the layer is called. ' +
        'WARNING: `deep: true` reads the whole file tree in one request, and Figma bills that endpoint by response ' +
        'size rather than by request count — on a large file a deep index can exhaust the shared Tier-1 budget by ' +
        'itself and block every user for days. Try the default shallow search first; only go deep when it found ' +
        'nothing, keep `depth` as low as it can be (default 3), and check figma_quota_status beforehand. ' +
        'The index is cached per file and depth, so pay it once.',
      inputSchema: {
        file,
        query: z.string().min(1).describe('Text to find in layer names. Case- and diacritic-insensitive.'),
        types: z.array(z.string()).optional().describe('Node types to keep. Default: any type.'),
        page: z.string().optional().describe('Only pages whose name contains this text.'),
        deep: z
          .boolean()
          .optional()
          .describe('Search nested layers by reading the whole file tree. Expensive on large files — see the warning. Default false.'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Levels to index when `deep`. Default 3. Each extra level multiplies the payload Figma bills you for.'),
        limit: z.number().int().min(1).max(500).optional().describe('Matches to return. Default 50.'),
        refresh,
      },
      annotations: { title: 'Find Figma layers by name', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_search_nodes', () => useCases.searchNodes.execute(args)),
  );

  server.registerTool(
    'figma_get_node_spec',
    {
      title: 'Read a Figma screen as a code-ready spec',
      description:
        'Read a frame and get back a flattened spec you can write code from in ONE call: ready-to-paste CSS declarations ' +
        '(flex direction, gap, padding, background, border, radius, box-shadow, font), all text content however deep it sits, ' +
        'and componentId for instances. Content-free wrapper layers are removed, so text is not buried under three levels ' +
        'of "Container". Use this, not figma_get_node_tree, when the goal is to implement a design; use figma_get_node_tree ' +
        'when you need Figma\'s exact structure and raw field values. ' +
        '1 batched Tier-1 request, cached and shared with figma_get_node_tree at the same depth. ' +
        '`vectorNodes` lists the icons in the result: pass those to figma_get_svg to get their shape.',
      inputSchema: {
        ids: z.array(z.string()).min(1).max(10).describe('Node ids ("12:34" or "12-34") or Figma frame links.'),
        file: file.optional().describe('Figma file URL or key. Optional when ids are full Figma links.'),
        depth: z.number().int().min(1).max(20).optional().describe('Levels of children to read. Default 10.'),
        maxNodes: z.number().int().min(1).max(5000).optional().describe('Cap on layers read. Default 1500.'),
        refresh,
      },
      annotations: { title: 'Read a Figma screen as a code-ready spec', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_get_node_spec', () => useCases.getNodeSpec.execute(args)),
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
        'and `rateLimited` says when to retry. ' +
        'Set `inline: true` to also receive the images in this result and look at them yourself — up to 5 png/jpg frames; ' +
        '`inlineSkipped` says why if the limits were not met.',
      inputSchema: {
        nodes: z.array(z.string()).min(1).max(1000).describe('Node ids ("12:34" or "12-34") or Figma frame links.'),
        file: file.optional().describe('Figma file URL or key. Optional when nodes are full Figma links.'),
        format: z.enum(IMAGE_FORMATS as unknown as [string, ...string[]]).optional().describe('Default jpg.'),
        scale: z.number().min(0.01).max(4).optional().describe('Render scale for jpg/png. Default 2.'),
        useAbsoluteBounds: z.boolean().optional().describe('Export the full node bounds without cropping.'),
        useLayerNames: z.boolean().optional().describe('Name files after layer names. Default true.'),
        createArchive: z.boolean().optional().describe('Also return a zip of all files. Default true.'),
        inline: z
          .boolean()
          .optional()
          .describe('Also return the images in this result so you can see them. png/jpg only, at most 5. Default false.'),
        refresh,
      },
      annotations: { title: 'Export Figma frames as images', readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      runMediaTool(context, 'figma_export_frames', async () => {
        const { previews, ...data } = await useCases.exportFrames.execute({
          ...args,
          format: args.format as (typeof IMAGE_FORMATS)[number] | undefined,
        });
        return { data, ...(previews ? { images: previews } : {}) };
      }),
  );

  server.registerTool(
    'figma_get_svg',
    {
      title: 'Read Figma vectors as SVG source',
      description:
        'Return the SVG source of icons and vector layers inline, ready to paste into markup. ' +
        'Use this for anything you have to draw: the node tree gives a VECTOR\'s bounds and colours but never its path, ' +
        'and figma_export_frames only gives a file to download. ' +
        '1 Tier-1 request per batch, and the render URLs are shared with figma_export_frames, so exporting the same nodes ' +
        'as svg first makes this free. Oversized SVGs are reported in `failed` rather than returned; raise maxBytesPerNode ' +
        'or export them as files instead.',
      inputSchema: {
        nodes: z.array(z.string()).min(1).max(50).describe('Node ids ("12:34" or "12-34") or Figma frame links.'),
        file: file.optional().describe('Figma file URL or key. Optional when nodes are full Figma links.'),
        maxBytesPerNode: z.number().int().min(256).max(524288).optional().describe('Skip SVGs larger than this. Default 24576.'),
        refresh,
      },
      annotations: { title: 'Read Figma vectors as SVG source', ...READ_ONLY },
    },
    (args) => runTool(context, 'figma_get_svg', () => useCases.getSvg.execute(args)),
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

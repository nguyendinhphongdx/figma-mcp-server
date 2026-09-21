import type { FileResolver } from '../shared/file-resolver.js';
import type { DataMeta } from '../shared/cache-ttls.js';
import type { FileOutlineService, OutlineNode } from './file-outline.js';

export interface ListFramesInput {
  /** Figma file URL or key. */
  readonly file: string;
  /** Only pages whose name contains this text (case-insensitive). */
  readonly page?: string | undefined;
  /** Node types to keep. Defaults to the things people export: frames, sections, components. */
  readonly types?: readonly string[] | undefined;
  /** Nodes to return across all pages. Default 200. */
  readonly limit?: number | undefined;
  /** Nodes to skip, for paging. Default 0. */
  readonly offset?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export interface ListFramesOutput {
  readonly file: { readonly key: string; readonly name: string; readonly lastModified: string; readonly version: string };
  readonly pages: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly nodes: readonly OutlineNode[];
  }>;
  /** Nodes matching the filters, before paging. */
  readonly totalNodes: number;
  /** Nodes actually included in `pages`. */
  readonly returned: number;
  readonly offset: number;
  /** True when nodes were left out: call again with a higher `offset`. */
  readonly hasMore: boolean;
  readonly meta: DataMeta;
}

export const DEFAULT_FRAME_TYPES: readonly string[] = ['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET'];
export const DEFAULT_FRAME_LIMIT = 200;
export const MAX_FRAME_LIMIT = 1_000;

/** Lists pages and their top-level frames: the starting point for picking what to export. */
export class ListFramesUseCase {
  constructor(
    private readonly files: FileResolver,
    private readonly outlines: FileOutlineService,
  ) {}

  async execute(input: ListFramesInput): Promise<ListFramesOutput> {
    const fileKey = this.files.resolve(input.file);
    const outline = await this.outlines.get(fileKey, { refresh: input.refresh });

    const types = new Set((input.types?.length ? input.types : DEFAULT_FRAME_TYPES).map((type) => type.toUpperCase()));
    const pageFilter = input.page?.trim().toLowerCase();

    const matching = outline.value.pages
      .filter((page) => !pageFilter || page.name.toLowerCase().includes(pageFilter))
      .map((page) => ({ ...page, nodes: page.nodes.filter((node) => types.has(node.type)) }));

    // A single design file can hold thousands of frames, which is more than a tool result can carry.
    // Paging runs across the pages so the caller walks the file in order instead of receiving all of it.
    const limit = clamp(input.limit ?? DEFAULT_FRAME_LIMIT, 1, MAX_FRAME_LIMIT);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const totalNodes = matching.reduce((sum, page) => sum + page.nodes.length, 0);

    const pages: Array<{ id: string; name: string; nodes: readonly OutlineNode[] }> = [];
    let skipped = 0;
    let taken = 0;
    for (const page of matching) {
      if (taken >= limit) break;
      if (skipped + page.nodes.length <= offset) {
        skipped += page.nodes.length;
        continue;
      }
      const from = Math.max(0, offset - skipped);
      const nodes = page.nodes.slice(from, from + (limit - taken));
      skipped += from;
      taken += nodes.length;
      if (nodes.length > 0) pages.push({ ...page, nodes });
    }

    const { key, name, lastModified, version } = outline.value.file;
    return {
      file: { key, name, lastModified, version },
      pages,
      totalNodes,
      returned: taken,
      offset,
      hasMore: offset + taken < totalNodes,
      meta: { cached: outline.cached, fetchedAt: outline.fetchedAt },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

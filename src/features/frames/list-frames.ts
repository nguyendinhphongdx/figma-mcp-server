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
  readonly refresh?: boolean | undefined;
}

export interface ListFramesOutput {
  readonly file: { readonly key: string; readonly name: string; readonly lastModified: string; readonly version: string };
  readonly pages: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly nodes: readonly OutlineNode[];
  }>;
  readonly totalNodes: number;
  readonly meta: DataMeta;
}

export const DEFAULT_FRAME_TYPES: readonly string[] = ['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET'];

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

    const pages = outline.value.pages
      .filter((page) => !pageFilter || page.name.toLowerCase().includes(pageFilter))
      .map((page) => ({ ...page, nodes: page.nodes.filter((node) => types.has(node.type)) }));

    const { key, name, lastModified, version } = outline.value.file;
    return {
      file: { key, name, lastModified, version },
      pages,
      totalNodes: pages.reduce((sum, page) => sum + page.nodes.length, 0),
      meta: { cached: outline.cached, fetchedAt: outline.fetchedAt },
    };
  }
}

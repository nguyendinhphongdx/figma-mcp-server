import type { FigmaApi, FigmaFileMeta, FigmaNode } from '../../core/figma/figma-api.js';
import type { CachedLoader, Loaded } from '../../core/cache/cached-loader.js';
import type { CacheTtls } from '../shared/cache-ttls.js';

export interface OutlineNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface OutlinePage {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly OutlineNode[];
}

/** Pages and their top-level objects: cheap to keep, and enough to name and find frames. */
export interface FileOutline {
  readonly file: FigmaFileMeta & { readonly key: string };
  readonly pages: readonly OutlinePage[];
}

export function outlineCacheKey(fileKey: string): string {
  return `outline:${fileKey}`;
}

function toOutlineNode(node: FigmaNode): OutlineNode {
  const box = node.absoluteBoundingBox;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: box ? Math.round(box.width) : null,
    height: box ? Math.round(box.height) : null,
  };
}

/**
 * Owns the one Tier 1 request (`GET file?depth=2`) that answers "what frames does this file have?",
 * caches it, and lets other features look names up in it for free.
 */
export class FileOutlineService {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly ttls: CacheTtls,
  ) {}

  get(fileKey: string, options: { refresh?: boolean | undefined } = {}): Promise<Loaded<FileOutline>> {
    return this.loader.getOrLoad(
      outlineCacheKey(fileKey),
      this.ttls.structureMs,
      async () => {
        const file = await this.api.getFile(fileKey, { depth: 2 });
        const { document, ...meta } = file;
        return {
          file: { key: fileKey, ...meta },
          pages: (document.children ?? []).map((page) => ({
            id: page.id,
            name: page.name,
            nodes: (page.children ?? []).map(toOutlineNode),
          })),
        } satisfies FileOutline;
      },
      options,
    );
  }

  /** Names for the given node ids if the outline is already cached; never contacts Figma. */
  async peekNames(fileKey: string, ids: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const cached = await this.loader.peek<FileOutline>(outlineCacheKey(fileKey));
    if (!cached) {
      return names;
    }
    const wanted = new Set(ids);
    for (const page of cached.value.pages) {
      for (const node of page.nodes) {
        if (wanted.has(node.id)) {
          names.set(node.id, node.name);
        }
      }
    }
    return names;
  }
}

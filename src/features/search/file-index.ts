import type { CachedLoader, Loaded } from '../../core/cache/cached-loader.js';
import type { FigmaApi, FigmaFileMeta, FigmaNode } from '../../core/figma/figma-api.js';
import type { CacheTtls } from '../shared/cache-ttls.js';

export interface IndexEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Page the node lives on. */
  readonly page: string;
  /** Ancestor names from the page down to the parent, e.g. `UI - 1 / Container`. */
  readonly path: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface FileIndex {
  readonly file: FigmaFileMeta & { readonly key: string };
  readonly entries: readonly IndexEntry[];
  /** True when `maxEntries` stopped the walk before the whole file was indexed. */
  readonly truncated: boolean;
  readonly depth: number;
}

/**
 * Keeps a deep index from exhausting memory on very large files.
 *
 * Measured against a real 3-page mockup file: depth 6 overran the original 40k cap, which made
 * `truncated` the normal answer rather than the exceptional one. An entry is small (six short
 * fields), so the ceiling can be generous before the cached index is worth worrying about.
 */
export const MAX_INDEX_ENTRIES = 120_000;

export function fileIndexCacheKey(fileKey: string, depth: number): string {
  return `index:${fileKey}:d${depth}`;
}

interface WalkState {
  readonly entries: IndexEntry[];
  truncated: boolean;
}

function walk(node: FigmaNode, page: string, path: readonly string[], depthRemaining: number, state: WalkState): void {
  for (const child of node.children ?? []) {
    if (state.entries.length >= MAX_INDEX_ENTRIES) {
      state.truncated = true;
      return;
    }
    const box = child.absoluteBoundingBox;
    state.entries.push({
      id: child.id,
      name: child.name,
      type: child.type,
      page,
      path: path.join(' / '),
      width: box ? Math.round(box.width) : null,
      height: box ? Math.round(box.height) : null,
    });
    if (depthRemaining > 1) {
      walk(child, page, [...path, child.name], depthRemaining - 1, state);
    }
  }
}

/**
 * A flat, searchable index of a file's layers.
 *
 * `figma_list_frames` answers "what is at the top of each page?" and nothing deeper, so finding a
 * named layer used to mean pulling the whole outline back and scanning it by hand. This owns the one
 * deep `GET file?depth=N` that makes name lookup possible, and caches it like every other structure read.
 */
export class FileIndexService {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly ttls: CacheTtls,
  ) {}

  get(fileKey: string, depth: number, options: { refresh?: boolean | undefined } = {}): Promise<Loaded<FileIndex>> {
    return this.loader.getOrLoad(
      fileIndexCacheKey(fileKey, depth),
      this.ttls.structureMs,
      async () => {
        // +1 because the document's own children are the pages, which are not themselves results.
        const file = await this.api.getFile(fileKey, { depth: depth + 1 });
        const { document, ...meta } = file;

        const state: WalkState = { entries: [], truncated: false };
        for (const page of document.children ?? []) {
          walk(page, page.name, [page.name], depth, state);
        }

        return {
          file: { key: fileKey, ...meta },
          entries: state.entries,
          truncated: state.truncated,
          depth,
        } satisfies FileIndex;
      },
      options,
    );
  }
}

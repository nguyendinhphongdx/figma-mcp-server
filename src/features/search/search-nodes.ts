import { InvalidInputError } from '../../core/domain/errors.js';
import type { DataMeta } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';
import { foldForSearch, looseIncludes } from '../shared/text-match.js';
import type { FileOutlineService } from '../frames/file-outline.js';
import type { FileIndexService, IndexEntry } from './file-index.js';

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 500;
/**
 * Deliberately shallow.
 *
 * A deep index is one `GET /v1/files?depth=N` request, but Figma meters that endpoint by response
 * size, not by request count — so "one request" is not one request's worth of budget. Measured the
 * hard way: a `depth: 6` index of a large mockup file earned the shared token a multi-day Tier-1
 * block on its own. Three levels reaches the layers people search for (a frame, its sections, their
 * direct children) at a fraction of the payload; deeper is an explicit, informed choice.
 */
export const DEFAULT_DEEP_DEPTH = 3;
export const MAX_DEEP_DEPTH = 10;

export interface SearchNodesInput {
  readonly file: string;
  /** Matched against layer names, case- and diacritic-insensitively. */
  readonly query: string;
  /** Node types to keep (any type by default). */
  readonly types?: readonly string[] | undefined;
  /** Only pages whose name contains this text. */
  readonly page?: string | undefined;
  /** Search nested layers too, not just the top level of each page. */
  readonly deep?: boolean | undefined;
  /** How many levels down to index when `deep`. Default 6. */
  readonly depth?: number | undefined;
  readonly limit?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export interface SearchNodesOutput {
  readonly file: { readonly key: string; readonly name: string; readonly lastModified: string; readonly version: string };
  readonly scope: 'top-level' | 'deep';
  readonly matches: readonly IndexEntry[];
  /** Matches found before `limit` was applied. */
  readonly totalMatches: number;
  readonly returned: number;
  /** True when the file was too large to index completely. */
  readonly indexTruncated: boolean;
  readonly meta: DataMeta;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Relevance, not document order.
 *
 * Figma names a text layer after its own content, so a design file holds thousands of layers named
 * with a whole paragraph. Searching "vai tro" in a real file matches 593 of them, and returning the
 * first few by document order buries the frame actually called "Vai trò" under essays that happen
 * to contain the words. Ranking by how much of the name the query accounts for fixes that.
 */
function relevance(name: string, query: string): number {
  const folded = foldForSearch(name);
  const needle = foldForSearch(query);
  if (folded === needle) return 0;
  if (folded.startsWith(needle)) return 1;
  return 2;
}

function byRelevance(query: string) {
  return (a: IndexEntry, b: IndexEntry): number => {
    const rank = relevance(a.name, query) - relevance(b.name, query);
    if (rank !== 0) return rank;
    // A shorter name means the query is more of what the layer is, rather than an aside in it.
    return a.name.length - b.name.length;
  };
}

/**
 * Finds layers by name.
 *
 * The shallow scope reuses the file outline every other tool already caches, so the common case
 * ("where is the frame called X?") costs nothing once any tool has touched the file. Only `deep`
 * spends a request, and only once per file and depth.
 */
export class SearchNodesUseCase {
  constructor(
    private readonly files: FileResolver,
    private readonly outlines: FileOutlineService,
    private readonly index: FileIndexService,
  ) {}

  async execute(input: SearchNodesInput): Promise<SearchNodesOutput> {
    if (input.query.trim().length === 0) {
      throw new InvalidInputError('`query` must not be empty; pass the layer name (or part of it) you are looking for.');
    }

    const fileKey = this.files.resolve(input.file);
    const limit = clamp(input.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const deep = input.deep ?? false;

    const found = deep
      ? await this.searchDeep(fileKey, input)
      : await this.searchTopLevel(fileKey, input);

    const types = input.types?.length ? new Set(input.types.map((type) => type.toUpperCase())) : undefined;
    const pageFilter = input.page?.trim();

    const matches = found.entries
      .filter(
        (entry) =>
          (!types || types.has(entry.type)) &&
          (!pageFilter || looseIncludes(entry.page, pageFilter)) &&
          looseIncludes(entry.name, input.query),
      )
      .sort(byRelevance(input.query));

    return {
      file: found.file,
      scope: deep ? 'deep' : 'top-level',
      matches: matches.slice(0, limit),
      totalMatches: matches.length,
      returned: Math.min(matches.length, limit),
      indexTruncated: found.truncated,
      meta: found.meta,
    };
  }

  private async searchTopLevel(fileKey: string, input: SearchNodesInput) {
    const outline = await this.outlines.get(fileKey, { refresh: input.refresh });
    const entries: IndexEntry[] = [];
    for (const page of outline.value.pages) {
      for (const node of page.nodes) {
        entries.push({ ...node, page: page.name, path: page.name });
      }
    }
    const { key, name, lastModified, version } = outline.value.file;
    return {
      file: { key, name, lastModified, version },
      entries,
      truncated: false,
      meta: { cached: outline.cached, fetchedAt: outline.fetchedAt } satisfies DataMeta,
    };
  }

  private async searchDeep(fileKey: string, input: SearchNodesInput) {
    const depth = clamp(input.depth ?? DEFAULT_DEEP_DEPTH, 1, MAX_DEEP_DEPTH);
    const index = await this.index.get(fileKey, depth, { refresh: input.refresh });
    const { key, name, lastModified, version } = index.value.file;
    return {
      file: { key, name, lastModified, version },
      entries: index.value.entries,
      truncated: index.value.truncated,
      meta: { cached: index.cached, fetchedAt: index.fetchedAt } satisfies DataMeta,
    };
  }
}

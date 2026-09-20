import { InvalidInputError } from '../../core/domain/errors.js';
import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi, FigmaNodesResult } from '../../core/figma/figma-api.js';
import type { DataMeta, CacheTtls } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';
import { projectNode, type IncludeGroup, type ProjectedNode } from './node-projection.js';

export const MAX_NODE_IDS = 50;
export const MAX_DEPTH = 10;
export const MAX_NODES_LIMIT = 2000;
export const DEFAULT_MAX_NODES = 500;

export interface GetNodeTreeInput {
  /** Figma file URL or key. Optional when `ids` are full Figma links. */
  readonly file?: string | undefined;
  /** Node ids (`1:2`) or frame links. */
  readonly ids: readonly string[];
  readonly depth?: number | undefined;
  readonly include?: readonly IncludeGroup[] | undefined;
  readonly maxNodes?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export interface GetNodeTreeOutput {
  readonly file: { readonly key: string; readonly name: string; readonly lastModified: string; readonly version: string };
  readonly nodes: Readonly<Record<string, ProjectedNode | null>>;
  /** True when `maxNodes` cut the tree short. */
  readonly truncated: boolean;
  readonly meta: DataMeta;
}

/** Reads the layer tree under specific nodes, in one batched request. */
export class GetNodeTreeUseCase {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly files: FileResolver,
    private readonly ttls: CacheTtls,
  ) {}

  async execute(input: GetNodeTreeInput): Promise<GetNodeTreeOutput> {
    if (input.ids.length === 0 || input.ids.length > MAX_NODE_IDS) {
      throw new InvalidInputError(`Provide between 1 and ${MAX_NODE_IDS} node ids.`);
    }

    const { fileKey, nodeIds } = this.files.resolveWithNodes(input.file, input.ids);
    // Sorted so the same set of ids always maps to the same cache entry.
    const ids = [...nodeIds].sort();

    const depth = clamp(input.depth ?? 2, 1, MAX_DEPTH);
    const maxNodes = clamp(input.maxNodes ?? DEFAULT_MAX_NODES, 1, MAX_NODES_LIMIT);
    const include = new Set<IncludeGroup>(input.include ?? []);

    // The raw response is cached (not the projection) so different `include` sets share one request.
    const loaded = await this.loader.getOrLoad<FigmaNodesResult>(
      `nodes:${fileKey}:d${depth}:${ids.join(',')}`,
      this.ttls.structureMs,
      () => this.api.getNodes(fileKey, ids, { depth }),
      { refresh: input.refresh },
    );

    const budget = { remaining: maxNodes, truncated: false };
    const nodes: Record<string, ProjectedNode | null> = {};
    for (const id of ids) {
      const raw = loaded.value.nodes[id] ?? null;
      if (raw && budget.remaining <= 0) {
        // Budget spent by earlier nodes: still report that this node exists, without its subtree.
        budget.truncated = true;
        nodes[id] = projectNode(raw, 0, include, budget);
      } else {
        nodes[id] = raw ? projectNode(raw, depth, include, budget) : null;
      }
    }

    const { name, lastModified, version } = loaded.value.meta;
    return {
      file: { key: fileKey, name, lastModified, version },
      nodes,
      truncated: budget.truncated,
      meta: { cached: loaded.cached, fetchedAt: loaded.fetchedAt },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

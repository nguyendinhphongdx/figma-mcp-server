import { InvalidInputError } from '../../core/domain/errors.js';
import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi, FigmaNodesResult } from '../../core/figma/figma-api.js';
import type { CacheTtls, DataMeta } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';
import { projectNode, type IncludeGroup } from './node-projection.js';
import { buildSpec, type SpecNode } from './node-spec.js';

export const MAX_SPEC_IDS = 10;
export const DEFAULT_SPEC_DEPTH = 10;
export const MAX_SPEC_DEPTH = 20;
export const DEFAULT_SPEC_MAX_NODES = 1_500;
export const MAX_SPEC_MAX_NODES = 5_000;

/** Every group: a spec is only useful when it carries layout, paint and type together. */
const ALL_GROUPS: ReadonlySet<IncludeGroup> = new Set<IncludeGroup>(['layout', 'style', 'text']);

export interface GetNodeSpecInput {
  readonly file?: string | undefined;
  readonly ids: readonly string[];
  readonly depth?: number | undefined;
  readonly maxNodes?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export interface GetNodeSpecOutput {
  readonly file: { readonly key: string; readonly name: string; readonly lastModified: string; readonly version: string };
  readonly nodes: Readonly<Record<string, SpecNode | null>>;
  /** Content-free wrapper layers removed across all requested nodes. */
  readonly collapsedWrappers: number;
  /** Vector layers found: pass these to figma_get_svg to get their actual shape. */
  readonly vectorNodes: readonly string[];
  readonly truncated: boolean;
  readonly meta: DataMeta;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Reads a subtree and flattens it into something you can write code from in one call.
 *
 * `figma_get_node_tree` mirrors Figma's structure faithfully, which means a caller implementing a
 * screen walks it several times over: the styled frame sits three levels above its own text, so each
 * `depth` guess either truncates the content or drags in the whole tree. This goes deep by default,
 * drops the layers that only add nesting, and emits CSS declarations instead of raw Figma fields.
 */
export class GetNodeSpecUseCase {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly files: FileResolver,
    private readonly ttls: CacheTtls,
  ) {}

  async execute(input: GetNodeSpecInput): Promise<GetNodeSpecOutput> {
    if (input.ids.length === 0 || input.ids.length > MAX_SPEC_IDS) {
      throw new InvalidInputError(`Provide between 1 and ${MAX_SPEC_IDS} node ids.`);
    }

    const { fileKey, nodeIds } = this.files.resolveWithNodes(input.file, input.ids);
    const ids = [...nodeIds].sort();
    const depth = clamp(input.depth ?? DEFAULT_SPEC_DEPTH, 1, MAX_SPEC_DEPTH);
    const maxNodes = clamp(input.maxNodes ?? DEFAULT_SPEC_MAX_NODES, 1, MAX_SPEC_MAX_NODES);

    // Same cache key shape as figma_get_node_tree, so the two tools share one Figma request
    // whenever they are called at the same depth.
    const loaded = await this.loader.getOrLoad<FigmaNodesResult>(
      `nodes:${fileKey}:d${depth}:${ids.join(',')}`,
      this.ttls.structureMs,
      () => this.api.getNodes(fileKey, ids, { depth }),
      { refresh: input.refresh },
    );

    const budget = { remaining: maxNodes, truncated: false };
    const nodes: Record<string, SpecNode | null> = {};
    const vectors = new Set<string>();
    let collapsed = 0;

    for (const id of ids) {
      const raw = loaded.value.nodes[id] ?? null;
      if (!raw) {
        nodes[id] = null;
        continue;
      }
      const spec = buildSpec(projectNode(raw, depth, ALL_GROUPS, budget));
      nodes[id] = spec.node;
      collapsed += spec.collapsed;
      spec.vectors.forEach((vector) => vectors.add(vector));
    }

    const { name, lastModified, version } = loaded.value.meta;
    return {
      file: { key: fileKey, name, lastModified, version },
      nodes,
      collapsedWrappers: collapsed,
      vectorNodes: [...vectors],
      truncated: budget.truncated,
      meta: { cached: loaded.cached, fetchedAt: loaded.fetchedAt },
    };
  }
}

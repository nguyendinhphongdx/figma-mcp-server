import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi, FigmaLibraryItem } from '../../core/figma/figma-api.js';
import type { CacheTtls, DataMeta } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;

export interface LibraryItemView {
  readonly key: string;
  readonly name: string;
  readonly nodeId: string;
  readonly description?: string;
  readonly styleType?: string;
  readonly page?: string;
  readonly frame?: string;
  readonly componentSet?: string;
  readonly updatedAt?: string;
}

export interface ListLibraryOutput {
  readonly file: string;
  readonly kind: LibraryKind;
  readonly total: number;
  readonly items: readonly LibraryItemView[];
  readonly truncated: boolean;
  readonly meta: DataMeta;
}

export type LibraryKind = 'styles' | 'components' | 'component_sets';

export interface ListLibraryInput {
  readonly file: string;
  readonly query?: string | undefined;
  /** For styles: FILL, TEXT, EFFECT or GRID. */
  readonly styleType?: string | undefined;
  readonly limit?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export function toView(item: FigmaLibraryItem): LibraryItemView {
  return {
    key: item.key,
    name: item.name,
    nodeId: item.node_id,
    ...(item.description ? { description: item.description } : {}),
    ...(item.style_type ? { styleType: item.style_type } : {}),
    ...(item.containing_frame?.pageName ? { page: item.containing_frame.pageName } : {}),
    ...(item.containing_frame?.name ? { frame: item.containing_frame.name } : {}),
    ...(item.containing_frame?.containingComponentSet ? { componentSet: item.containing_frame.containingComponentSet } : {}),
    ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
  };
}

/** Shared read path for the file's published styles, components and component sets (Tier 3). */
export class LibraryReader {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly ttls: CacheTtls,
  ) {}

  read(fileKey: string, kind: LibraryKind, refresh: boolean | undefined) {
    const load = {
      styles: () => this.api.getStyles(fileKey),
      components: () => this.api.getComponents(fileKey),
      component_sets: () => this.api.getComponentSets(fileKey),
    }[kind];
    return this.loader.getOrLoad<readonly FigmaLibraryItem[]>(`library:${fileKey}:${kind}`, this.ttls.structureMs, load, { refresh });
  }
}

/** Lists styles, components or component sets of a file, optionally filtered by name. */
export class ListLibraryUseCase {
  constructor(
    private readonly kind: LibraryKind,
    private readonly files: FileResolver,
    private readonly reader: LibraryReader,
  ) {}

  async execute(input: ListLibraryInput): Promise<ListLibraryOutput> {
    const fileKey = this.files.resolve(input.file);
    const loaded = await this.reader.read(fileKey, this.kind, input.refresh);

    const query = input.query?.trim().toLowerCase();
    const styleType = input.styleType?.toUpperCase();
    const matching = loaded.value.filter(
      (item) =>
        (!query || item.name.toLowerCase().includes(query)) &&
        (!styleType || item.style_type === styleType),
    );

    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIST_LIMIT)));
    return {
      file: fileKey,
      kind: this.kind,
      total: matching.length,
      items: matching.slice(0, limit).map(toView),
      truncated: matching.length > limit,
      meta: { cached: loaded.cached, fetchedAt: loaded.fetchedAt },
    };
  }
}

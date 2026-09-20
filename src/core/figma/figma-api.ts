export type ImageFormat = 'jpg' | 'png' | 'svg' | 'pdf';
export const IMAGE_FORMATS: readonly ImageFormat[] = ['jpg', 'png', 'svg', 'pdf'];

/** Formats for which the Figma images endpoint honours the `scale` parameter. */
export function supportsScale(format: ImageFormat): boolean {
  return format === 'jpg' || format === 'png';
}

export interface FigmaBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A node as returned by the API. Only the fields this server relies on are typed. */
export interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible?: boolean;
  readonly children?: readonly FigmaNode[];
  readonly absoluteBoundingBox?: FigmaBox | null;
  readonly characters?: string;
  readonly [key: string]: unknown;
}

export interface FigmaFileMeta {
  readonly name: string;
  readonly lastModified: string;
  readonly version: string;
  readonly editorType?: string;
  readonly thumbnailUrl?: string;
}

export interface FigmaFile extends FigmaFileMeta {
  readonly document: FigmaNode;
}

export interface FigmaNodesResult {
  readonly meta: FigmaFileMeta;
  /** null for ids that do not exist in the file. */
  readonly nodes: Readonly<Record<string, FigmaNode | null>>;
}

export interface FigmaComment {
  readonly id: string;
  readonly message?: string;
  readonly parent_id?: string;
  readonly created_at: string;
  readonly resolved_at?: string | null;
  readonly order_id?: number | string | null;
  readonly user?: { readonly id?: string; readonly handle?: string };
  readonly client_meta?: { readonly node_id?: string } | null;
}

export interface FigmaLibraryItem {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly node_id: string;
  readonly style_type?: string;
  readonly updated_at?: string;
  readonly containing_frame?: {
    readonly name?: string;
    readonly nodeId?: string;
    readonly pageName?: string;
    readonly containingComponentSet?: string;
  };
}

export interface ImageUrlRequest {
  readonly fileKey: string;
  readonly ids: readonly string[];
  readonly format: ImageFormat;
  /** Ignored for svg/pdf. */
  readonly scale: number;
  readonly useAbsoluteBounds: boolean;
}

/** node id -> temporary image URL, or `null` when Figma could not render the node. */
export type ImageUrlMap = Readonly<Record<string, string | null>>;

/**
 * Port for the parts of the Figma REST API this server needs.
 * Every method spends rate-limit budget; callers must batch ids and cache results.
 */
export interface FigmaApi {
  /** Tier 1. `depth: 2` returns pages plus their top-level objects. */
  getFile(fileKey: string, options?: { depth?: number }): Promise<FigmaFile>;
  /** Tier 1. */
  getNodes(fileKey: string, ids: readonly string[], options?: { depth?: number }): Promise<FigmaNodesResult>;
  /** Tier 1. */
  getImageUrls(request: ImageUrlRequest): Promise<ImageUrlMap>;
  /** Tier 2. */
  getComments(fileKey: string, options?: { asMarkdown?: boolean }): Promise<readonly FigmaComment[]>;
  /** Tier 3. */
  getStyles(fileKey: string): Promise<readonly FigmaLibraryItem[]>;
  /** Tier 3. */
  getComponents(fileKey: string): Promise<readonly FigmaLibraryItem[]>;
  /** Tier 3. */
  getComponentSets(fileKey: string): Promise<readonly FigmaLibraryItem[]>;
}

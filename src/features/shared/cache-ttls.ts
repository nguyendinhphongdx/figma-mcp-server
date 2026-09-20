export interface CacheTtls {
  /** File outlines, node trees, library listings, design tokens. */
  readonly structureMs: number;
  readonly commentsMs: number;
  /** Figma image URLs are valid for 30 days; stay safely below that. */
  readonly imageUrlMs: number;
}

/** What a tool reports about where its data came from. */
export interface DataMeta {
  /** True when served from the server's cache: no Figma request was spent. */
  readonly cached: boolean;
  readonly fetchedAt: string;
}

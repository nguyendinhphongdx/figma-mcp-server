import { normalizeNodeId } from '../../core/domain/figma-ref.js';
import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi, FigmaComment } from '../../core/figma/figma-api.js';
import type { CacheTtls, DataMeta } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';

export const DEFAULT_THREAD_LIMIT = 50;
export const MAX_THREAD_LIMIT = 200;

export type CommentStatus = 'all' | 'open' | 'resolved';

export interface GetCommentsInput {
  readonly file: string;
  readonly status?: CommentStatus | undefined;
  /** Only threads pinned to this node (`1:2` or `1-2`). */
  readonly nodeId?: string | undefined;
  readonly limit?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export interface CommentView {
  readonly id: string;
  readonly author: string | null;
  readonly createdAt: string;
  readonly message: string;
}

export interface ThreadView extends CommentView {
  readonly resolvedAt: string | null;
  readonly nodeId: string | null;
  readonly replies: readonly CommentView[];
}

export interface GetCommentsOutput {
  readonly file: string;
  readonly total: number;
  readonly threads: readonly ThreadView[];
  readonly truncated: boolean;
  readonly meta: DataMeta;
}

function toView(comment: FigmaComment): CommentView {
  return {
    id: comment.id,
    author: comment.user?.handle ?? null,
    createdAt: comment.created_at,
    message: comment.message ?? '',
  };
}

/** Groups Figma's flat comment list into threads (top-level comment plus replies). */
export function buildThreads(comments: readonly FigmaComment[]): ThreadView[] {
  const replies = new Map<string, FigmaComment[]>();
  for (const comment of comments) {
    if (comment.parent_id) {
      replies.set(comment.parent_id, [...(replies.get(comment.parent_id) ?? []), comment]);
    }
  }

  return comments
    .filter((comment) => !comment.parent_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((root) => ({
      ...toView(root),
      resolvedAt: root.resolved_at ?? null,
      nodeId: root.client_meta?.node_id ?? null,
      replies: (replies.get(root.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(toView),
    }));
}

/** Reads comment threads of a file (Tier 2), newest first. */
export class GetCommentsUseCase {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly files: FileResolver,
    private readonly ttls: CacheTtls,
  ) {}

  async execute(input: GetCommentsInput): Promise<GetCommentsOutput> {
    const fileKey = this.files.resolve(input.file);
    const loaded = await this.loader.getOrLoad<readonly FigmaComment[]>(
      `comments:${fileKey}`,
      this.ttls.commentsMs,
      () => this.api.getComments(fileKey),
      { refresh: input.refresh },
    );

    const status = input.status ?? 'all';
    const nodeId = input.nodeId ? normalizeNodeId(input.nodeId) : undefined;
    const matching = buildThreads(loaded.value).filter(
      (thread) =>
        (status === 'all' || (status === 'resolved') === (thread.resolvedAt !== null)) &&
        (!nodeId || thread.nodeId === nodeId),
    );

    const limit = Math.min(MAX_THREAD_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_THREAD_LIMIT)));
    return {
      file: fileKey,
      total: matching.length,
      threads: matching.slice(0, limit),
      truncated: matching.length > limit,
      meta: { cached: loaded.cached, fetchedAt: loaded.fetchedAt },
    };
  }
}

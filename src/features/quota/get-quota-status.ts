import type { CacheStats, CachedLoader } from '../../core/cache/cached-loader.js';
import type { GovernorStatus, RateLimitGate } from '../../core/rate-limit/governor.js';
import type { FileAccessPolicy } from '../../core/security/file-access-policy.js';

export interface QuotaStatusOutput extends GovernorStatus {
  readonly cache: CacheStats;
  readonly fileRestrictions: boolean;
  /** How to read the numbers, so an agent can decide whether to spend more requests. */
  readonly guidance: readonly string[];
}

/** Lets a caller check the shared Figma budget before deciding to spend it. Costs nothing. */
export class GetQuotaStatusUseCase {
  constructor(
    private readonly gate: RateLimitGate,
    private readonly loader: CachedLoader,
    private readonly policy: FileAccessPolicy,
  ) {}

  execute(): QuotaStatusOutput {
    return {
      ...this.gate.status(),
      cache: this.loader.stats(),
      fileRestrictions: this.policy.restricted,
      guidance: [
        'Tier 1: file structure, node trees, image export. Tier 2: comments. Tier 3: styles and components.',
        'A tier with blockedUntil set is refusing requests until that time; do not retry before then.',
        'availableSlots is how many requests can go out back-to-back right now; the rest are paced per minute.',
        'Every teammate shares this budget: prefer cached results and batch ids into one call.',
      ],
    };
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedUrlParts {
  readonly expiresAt: number;
  readonly signature: string;
}

/**
 * HMAC-SHA256 signer for time-limited download links.
 * Exported images are served to people who do not hold an MCP API key (a link pasted into a
 * browser or a script), so the link itself must carry proof that this server issued it, and
 * that proof must expire.
 */
export class UrlSigner {
  constructor(
    private readonly secret: string,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** `resource` is the canonical identifier being granted, e.g. `<exportId>/<fileName>`. */
  sign(resource: string, ttlSeconds: number): SignedUrlParts {
    const expiresAt = this.nowSeconds() + ttlSeconds;
    return { expiresAt, signature: this.mac(resource, expiresAt) };
  }

  verify(resource: string, expiresAt: number, signature: string): boolean {
    if (!Number.isInteger(expiresAt) || expiresAt < this.nowSeconds()) {
      return false;
    }
    const expected = Buffer.from(this.mac(resource, expiresAt));
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private mac(resource: string, expiresAt: number): string {
    return createHmac('sha256', this.secret).update(`${resource}\n${expiresAt}`).digest('base64url');
  }
}

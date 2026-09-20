import { DownloadError } from '../domain/errors.js';

export interface ImageUrlPolicyOptions {
  /** Hostname suffixes images may be fetched from, e.g. `amazonaws.com`. */
  readonly allowedHostSuffixes: readonly string[];
  /** Permit plain http. Only for local tests; never in production. */
  readonly allowInsecure: boolean;
}

/**
 * The server downloads URLs that come out of an API response. That is a server-side request
 * forgery surface if the response were ever tampered with, so only https URLs on known
 * image hosts are fetched.
 */
export class ImageUrlPolicy {
  constructor(private readonly options: ImageUrlPolicyOptions) {}

  assertAllowed(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new DownloadError('Figma returned an invalid image URL.');
    }

    if (url.protocol !== 'https:' && !(this.options.allowInsecure && url.protocol === 'http:')) {
      throw new DownloadError(`Refusing to download from a non-https URL (${url.protocol}).`);
    }
    if (url.username || url.password) {
      throw new DownloadError('Refusing to download from a URL that embeds credentials.');
    }

    const host = url.hostname.toLowerCase();
    const allowed = this.options.allowedHostSuffixes.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    if (!allowed) {
      throw new DownloadError(
        `Image host "${host}" is not in IMAGE_HOST_ALLOWLIST; add it if it is a legitimate Figma image host.`,
      );
    }
    return url;
  }
}

import type { DownloadLinks } from '../../features/export/export-frames.js';
import type { UrlSigner } from '../../core/security/url-signer.js';

export const ARCHIVE_NAME = 'archive.zip';

/** Resource string that a signature covers for a single exported file. */
export function fileResource(exportId: string, fileName: string): string {
  return `${exportId}/${fileName}`;
}

/** Resource string that a signature covers for the zip of a whole export. */
export function archiveResource(exportId: string): string {
  return `${exportId}/${ARCHIVE_NAME}`;
}

/** Builds time-limited, HMAC-signed links to the download routes served by the HTTP adapter. */
export class SignedDownloadLinks implements DownloadLinks {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: UrlSigner,
    private readonly ttlSeconds: number,
  ) {}

  forFile(exportId: string, fileName: string) {
    const { expiresAt, signature } = this.signer.sign(fileResource(exportId, fileName), this.ttlSeconds);
    return {
      url: `${this.baseUrl}/exports/${exportId}/files/${encodeURIComponent(fileName)}?exp=${expiresAt}&sig=${signature}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }

  forArchive(exportId: string) {
    const { expiresAt, signature } = this.signer.sign(archiveResource(exportId), this.ttlSeconds);
    return {
      url: `${this.baseUrl}/exports/${exportId}/${ARCHIVE_NAME}?exp=${expiresAt}&sig=${signature}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }
}

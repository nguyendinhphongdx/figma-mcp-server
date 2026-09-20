import { ForbiddenFileError } from '../domain/errors.js';

/**
 * The server talks to Figma with one shared identity, so every MCP user could otherwise reach
 * every file that identity can open. An allow-list narrows that to the files the team means to expose.
 * An empty list means "no restriction".
 */
export class FileAccessPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(allowedFileKeys: readonly string[]) {
    this.allowed = new Set(allowedFileKeys);
  }

  assertAllowed(fileKey: string): void {
    if (this.allowed.size > 0 && !this.allowed.has(fileKey)) {
      throw new ForbiddenFileError(
        `File ${fileKey} is not enabled on this server. Ask an admin to add it to FIGMA_ALLOWED_FILE_KEYS.`,
      );
    }
  }

  get restricted(): boolean {
    return this.allowed.size > 0;
  }
}

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidInputError } from '../domain/errors.js';

export interface StoredFile {
  readonly fileName: string;
  readonly bytes: number;
}

export interface OpenedFile {
  readonly stream: Readable;
  readonly bytes: number;
}

/** Where exported images live until their retention period ends. */
export interface ExportStorage {
  save(exportId: string, fileName: string, body: Readable): Promise<StoredFile>;
  open(exportId: string, fileName: string): Promise<OpenedFile | undefined>;
  list(exportId: string): Promise<StoredFile[]>;
  /** Deletes exports last modified before `cutoffMs`; returns how many were removed. */
  purgeOlderThan(cutoffMs: number): Promise<number>;
}

const EXPORT_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_FILE_NAME_LENGTH = 200;

/** Rejects anything that could escape the export directory. */
export function assertSafeFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName.length > MAX_FILE_NAME_LENGTH ||
    fileName === '.' ||
    fileName === '..' ||
    /[/\\\u0000]/.test(fileName)
  ) {
    throw new InvalidInputError(`Unsafe file name "${fileName}".`);
  }
}

export function isExportId(value: string): boolean {
  return EXPORT_ID_PATTERN.test(value);
}

export class LocalDiskExportStorage implements ExportStorage {
  constructor(private readonly rootDirectory: string) {}

  async save(exportId: string, fileName: string, body: Readable): Promise<StoredFile> {
    const directory = this.directoryFor(exportId);
    assertSafeFileName(fileName);

    await mkdir(directory, { recursive: true });
    const finalPath = join(directory, fileName);
    const partialPath = `${finalPath}.part`;
    try {
      await pipeline(body, createWriteStream(partialPath));
      await rename(partialPath, finalPath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
    return { fileName, bytes: (await stat(finalPath)).size };
  }

  async open(exportId: string, fileName: string): Promise<OpenedFile | undefined> {
    if (!isExportId(exportId)) {
      return undefined;
    }
    try {
      assertSafeFileName(fileName);
    } catch {
      return undefined;
    }
    const path = join(this.rootDirectory, exportId, fileName);
    try {
      const info = await stat(path);
      return info.isFile() ? { stream: createReadStream(path), bytes: info.size } : undefined;
    } catch {
      return undefined;
    }
  }

  async list(exportId: string): Promise<StoredFile[]> {
    if (!isExportId(exportId)) {
      return [];
    }
    const directory = join(this.rootDirectory, exportId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }

    const files: StoredFile[] = [];
    for (const name of names.filter((entry) => !entry.endsWith('.part')).sort()) {
      const info = await stat(join(directory, name));
      if (info.isFile()) {
        files.push({ fileName: name, bytes: info.size });
      }
    }
    return files;
  }

  async purgeOlderThan(cutoffMs: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDirectory);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const entry of entries.filter(isExportId)) {
      const directory = join(this.rootDirectory, entry);
      const info = await stat(directory).catch(() => undefined);
      if (info && info.mtimeMs < cutoffMs) {
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private directoryFor(exportId: string): string {
    if (!isExportId(exportId)) {
      throw new InvalidInputError('Invalid export id.');
    }
    return join(this.rootDirectory, exportId);
  }
}

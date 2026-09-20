import { InvalidInputError } from '../../core/domain/errors.js';
import { parseNodeInput, resolveFileKey } from '../../core/domain/figma-ref.js';
import type { FileAccessPolicy } from '../../core/security/file-access-policy.js';

export interface ResolvedNodes {
  readonly fileKey: string;
  /** Normalised (`1:2`) and de-duplicated, in input order. */
  readonly nodeIds: string[];
}

/** Turns whatever the caller typed (URLs, keys, ids) into an allowed file key and clean node ids. */
export class FileResolver {
  constructor(private readonly policy: FileAccessPolicy) {}

  resolve(fileInput: string): string {
    const fileKey = resolveFileKey(fileInput);
    this.policy.assertAllowed(fileKey);
    return fileKey;
  }

  /**
   * Node inputs may be bare ids or full Figma links; links carry their own file key.
   * The file must come from `explicitFile`, from the links, or both (and then they must agree).
   */
  resolveWithNodes(explicitFile: string | undefined, rawNodes: readonly string[]): ResolvedNodes {
    const parsed = rawNodes.map(parseNodeInput);

    const linkedKeys = new Set(parsed.flatMap((entry) => (entry.fileKey ? [entry.fileKey] : [])));
    if (linkedKeys.size > 1) {
      throw new InvalidInputError('The links point to several Figma files; use one file at a time.');
    }
    const [linkedKey] = linkedKeys;
    const explicitKey = explicitFile ? resolveFileKey(explicitFile) : undefined;
    if (explicitKey && linkedKey && explicitKey !== linkedKey) {
      throw new InvalidInputError('`file` does not match the file in the provided links.');
    }

    const fileKey = explicitKey ?? linkedKey;
    if (!fileKey) {
      throw new InvalidInputError('Cannot tell which Figma file to use: pass `file` or use full Figma links.');
    }
    this.policy.assertAllowed(fileKey);

    return { fileKey, nodeIds: [...new Set(parsed.map((entry) => entry.nodeId))] };
  }
}

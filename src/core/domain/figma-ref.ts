import { InvalidInputError } from './errors.js';

const NODE_ID_PATTERN = /^(\d+)[:-](\d+)$/;
const FILE_KEY_PATTERN = /^[A-Za-z0-9]{10,}$/;
const URL_PATH_PATTERN = /^\/(?:design|file|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/;

export interface ParsedFigmaUrl {
  readonly fileKey: string;
  readonly nodeId?: string;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Normalises a node id to the API form (`1:2`).
 * Figma URLs use `1-2`, the API uses `1:2`.
 */
export function normalizeNodeId(raw: string): string {
  const match = NODE_ID_PATTERN.exec(raw.trim());
  if (!match) {
    throw new InvalidInputError(`Invalid node id "${raw}". Expected "123:456" or "123-456".`);
  }
  return `${match[1]}:${match[2]}`;
}

/**
 * Extracts the file key (and node id, if present) from a Figma URL.
 * For branch URLs the branch key is the file key the API expects.
 */
export function parseFigmaUrl(raw: string): ParsedFigmaUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidInputError(`"${raw}" is not a valid URL.`);
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new InvalidInputError(`"${raw}" is not a figma.com URL.`);
  }

  const match = URL_PATH_PATTERN.exec(url.pathname);
  if (!match?.[1]) {
    throw new InvalidInputError(`Could not find a file key in the Figma URL "${raw}".`);
  }

  const fileKey = match[2] ?? match[1];
  const rawNodeId = url.searchParams.get('node-id');
  return rawNodeId ? { fileKey, nodeId: normalizeNodeId(rawNodeId) } : { fileKey };
}

/** Accepts either a bare file key or a Figma file/frame URL. */
export function resolveFileKey(raw: string): string {
  const value = raw.trim();
  if (looksLikeUrl(value)) {
    return parseFigmaUrl(value).fileKey;
  }
  if (!FILE_KEY_PATTERN.test(value)) {
    throw new InvalidInputError(`"${raw}" is neither a Figma file URL nor a file key.`);
  }
  return value;
}

export interface ParsedNodeInput {
  /** Present when the input was a full Figma link. */
  readonly fileKey?: string;
  readonly nodeId: string;
}

/** Accepts a node id (`1:2`, `1-2`) or a Figma link that carries `node-id`. */
export function parseNodeInput(raw: string): ParsedNodeInput {
  const value = raw.trim();
  if (looksLikeUrl(value)) {
    const { fileKey, nodeId } = parseFigmaUrl(value);
    if (!nodeId) {
      throw new InvalidInputError(`The URL "${raw}" has no node-id; copy the link of a selected frame instead.`);
    }
    return { fileKey, nodeId };
  }
  return { nodeId: normalizeNodeId(value) };
}

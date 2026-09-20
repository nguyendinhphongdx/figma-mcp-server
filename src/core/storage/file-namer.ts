import type { ImageFormat } from '../figma/figma-api.js';

const MAX_NAME_LENGTH = 80;
// Characters that are illegal in file names on Windows/macOS/Linux, plus control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Makes a Figma layer name safe to use inside a file name while keeping Unicode letters. */
export function sanitizeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(UNSAFE_CHARACTERS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');

  const truncated = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  if (truncated.length === 0) {
    return '';
  }
  return WINDOWS_RESERVED.test(truncated) ? `_${truncated}` : truncated;
}

/**
 * `<name>__<id>.<ext>` when a name is known, `<id>.<ext>` otherwise.
 * The node id is always part of the name, which guarantees uniqueness even
 * when several frames share a layer name.
 */
export function buildFileName(node: { readonly id: string; readonly name?: string | undefined }, format: ImageFormat): string {
  const idPart = node.id.replace(':', '-');
  const namePart = node.name ? sanitizeName(node.name) : '';
  const stem = namePart.length > 0 ? `${namePart}__${idPart}` : idPart;
  return `${stem}.${format}`;
}

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Admin UI documentation pages: real `.md` files under `docs/`, served at `GET /api/docs` and
 * `GET /api/docs/:slug`. `tsc` mirrors `src/` into `dist/` 1:1 but only compiles `.ts`, so the
 * build step copies this folder alongside the compiled JS (see `package.json`'s `build` script) —
 * `docs/` then sits next to this file's own output in both `src` (dev, via tsx) and `dist` (prod),
 * so the same relative path resolves in either case. */
const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'docs');

const ICONS: Record<string, string> = {
  'getting-started': '&#128640;',
  tools: '&#128295;',
  'design-to-code': '&#127912;',
  'rate-limits': '&#9201;',
  architecture: '&#127959;',
};

/**
 * Reading order, not alphabetical order: set up, learn the tools, do the work, then the two pages
 * you only open when something is wrong. Anything not listed here sorts alphabetically after these.
 */
const ORDER = ['getting-started', 'tools', 'design-to-code', 'rate-limits', 'architecture'];

function compareSlugs(a: string, b: string): number {
  const left = ORDER.indexOf(a);
  const right = ORDER.indexOf(b);
  if (left === -1 && right === -1) return a.localeCompare(b);
  if (left === -1) return 1;
  if (right === -1) return -1;
  return left - right;
}

export interface DocSummary {
  readonly slug: string;
  readonly title: string;
  readonly icon: string;
}

export async function listDocs(): Promise<DocSummary[]> {
  let files: string[];
  try {
    files = await readdir(DOCS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort(compareSlugs)
    .map((slug) => ({
      slug,
      title: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      icon: ICONS[slug] ?? '&#128196;',
    }));
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export async function readDoc(slug: string): Promise<string | undefined> {
  if (!SLUG_PATTERN.test(slug)) return undefined;
  try {
    return await readFile(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
  } catch {
    return undefined;
  }
}

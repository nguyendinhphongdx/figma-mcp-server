import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi, FigmaNode } from '../../core/figma/figma-api.js';
import { chunk } from '../../infra/pool.js';
import { simplifyPaints, toHex, type Rgba, type SimplePaint } from '../shared/color.js';
import type { CacheTtls, DataMeta } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';
import type { LibraryReader } from '../library/list-library.js';

export interface ColorToken {
  readonly name: string;
  readonly path: readonly string[];
  readonly value: SimplePaint[];
  readonly description?: string;
}

export interface TypographyToken {
  readonly name: string;
  readonly path: readonly string[];
  readonly value: Record<string, unknown>;
  readonly description?: string;
}

export interface EffectToken {
  readonly name: string;
  readonly path: readonly string[];
  readonly value: ReadonlyArray<Record<string, unknown>>;
  readonly description?: string;
}

export interface DesignTokens {
  readonly colors: readonly ColorToken[];
  readonly typography: readonly TypographyToken[];
  readonly effects: readonly EffectToken[];
  /** Styles Figma listed but whose node could not be read. */
  readonly unresolved: readonly string[];
}

export type TokenFormat = 'json' | 'css';

export interface GetDesignTokensInput {
  readonly file: string;
  readonly format?: TokenFormat | undefined;
  readonly refresh?: boolean | undefined;
}

export interface GetDesignTokensOutput {
  readonly file: string;
  readonly tokens: DesignTokens;
  /** Present when `format` is `css`. */
  readonly css?: string;
  readonly meta: DataMeta;
  /** What this tool does not cover, so nobody assumes it is complete. */
  readonly notes: readonly string[];
}

const TEXT_FIELDS = [
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeightPx',
  'lineHeightPercentFontSize',
  'letterSpacing',
  'textCase',
  'textDecoration',
] as const;

export function toPath(styleName: string): string[] {
  return styleName.split('/').map((part) => part.trim()).filter(Boolean);
}

export function slug(parts: readonly string[]): string {
  return parts
    .join('-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function shadow(effect: Record<string, unknown>): Record<string, unknown> {
  return {
    type: effect.type,
    ...(effect.color ? { color: toHex(effect.color as Rgba) } : {}),
    ...(effect.offset ? { offset: effect.offset } : {}),
    ...(effect.radius !== undefined ? { radius: effect.radius } : {}),
    ...(effect.spread !== undefined ? { spread: effect.spread } : {}),
  };
}

function typographyOf(node: FigmaNode): Record<string, unknown> {
  const style = (node.style ?? {}) as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    if (style[field] !== undefined && style[field] !== null) value[field] = style[field];
  }
  return value;
}

/** Renders tokens as CSS custom properties. Colours only expose the first solid fill. */
export function toCss(tokens: DesignTokens): string {
  const lines: string[] = [':root {'];

  for (const token of tokens.colors) {
    const first = token.value[0];
    if (first?.type === 'SOLID' && 'color' in first) {
      lines.push(`  --color-${slug(token.path)}: ${first.color};`);
    } else if (first && 'stops' in first) {
      const stops = first.stops.map((stop) => `${stop.color} ${Math.round(stop.position * 100)}%`).join(', ');
      lines.push(`  --gradient-${slug(token.path)}: linear-gradient(${stops});`);
    }
  }

  for (const token of tokens.typography) {
    const base = `--font-${slug(token.path)}`;
    const { fontFamily, fontWeight, fontSize, lineHeightPx, letterSpacing } = token.value;
    if (fontFamily) lines.push(`  ${base}-family: "${String(fontFamily)}";`);
    if (fontWeight) lines.push(`  ${base}-weight: ${String(fontWeight)};`);
    if (fontSize) lines.push(`  ${base}-size: ${String(fontSize)}px;`);
    if (lineHeightPx) lines.push(`  ${base}-line-height: ${Number(lineHeightPx).toFixed(2).replace(/\.?0+$/, '')}px;`);
    if (letterSpacing) lines.push(`  ${base}-letter-spacing: ${Number(letterSpacing).toFixed(2).replace(/\.?0+$/, '')}px;`);
  }

  for (const token of tokens.effects) {
    const shadows = token.value
      .filter((effect) => String(effect.type).endsWith('SHADOW'))
      .map((effect) => {
        const offset = (effect.offset ?? { x: 0, y: 0 }) as { x: number; y: number };
        const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : '';
        return `${inset}${offset.x}px ${offset.y}px ${Number(effect.radius ?? 0)}px ${Number(effect.spread ?? 0)}px ${String(effect.color ?? '#000000')}`;
      });
    if (shadows.length > 0) lines.push(`  --shadow-${slug(token.path)}: ${shadows.join(', ')};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Builds design tokens from the file's published styles.
 * Cost: one Tier 3 request for the style list plus one Tier 1 request per 100 style nodes,
 * all cached; a warm cache makes this free.
 */
export class GetDesignTokensUseCase {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly files: FileResolver,
    private readonly reader: LibraryReader,
    private readonly ttls: CacheTtls,
    private readonly batchSize: number,
  ) {}

  async execute(input: GetDesignTokensInput): Promise<GetDesignTokensOutput> {
    const fileKey = this.files.resolve(input.file);

    const loaded = await this.loader.getOrLoad<DesignTokens>(
      `tokens:${fileKey}`,
      this.ttls.structureMs,
      () => this.build(fileKey, input.refresh),
      { refresh: input.refresh },
    );

    return {
      file: fileKey,
      tokens: loaded.value,
      ...(input.format === 'css' ? { css: toCss(loaded.value) } : {}),
      meta: { cached: loaded.cached, fetchedAt: loaded.fetchedAt },
      notes: [
        'Built from published styles (FILL, TEXT, EFFECT). Figma Variables are not exposed by the REST API on most plans and are not included.',
        'Colour tokens list every visible fill; the CSS output uses the first solid fill or gradient only.',
      ],
    };
  }

  private async build(fileKey: string, refresh: boolean | undefined): Promise<DesignTokens> {
    const styles = (await this.reader.read(fileKey, 'styles', refresh)).value;
    const wanted = styles.filter((style) => ['FILL', 'TEXT', 'EFFECT'].includes(style.style_type ?? ''));

    const nodes = new Map<string, FigmaNode | null>();
    for (const ids of chunk(wanted.map((style) => style.node_id), this.batchSize)) {
      const result = await this.api.getNodes(fileKey, ids, { depth: 1 });
      for (const id of ids) nodes.set(id, result.nodes[id] ?? null);
    }

    const colors: ColorToken[] = [];
    const typography: TypographyToken[] = [];
    const effects: EffectToken[] = [];
    const unresolved: string[] = [];

    for (const style of wanted) {
      const node = nodes.get(style.node_id);
      if (!node) {
        unresolved.push(style.name);
        continue;
      }
      const base = {
        name: style.name,
        path: toPath(style.name),
        ...(style.description ? { description: style.description } : {}),
      };

      if (style.style_type === 'FILL') {
        colors.push({ ...base, value: simplifyPaints(node.fills) });
      } else if (style.style_type === 'TEXT') {
        typography.push({ ...base, value: typographyOf(node) });
      } else if (Array.isArray(node.effects)) {
        effects.push({
          ...base,
          value: (node.effects as Array<Record<string, unknown>>).filter((effect) => effect.visible !== false).map(shadow),
        });
      }
    }
    return { colors, typography, effects, unresolved };
  }
}

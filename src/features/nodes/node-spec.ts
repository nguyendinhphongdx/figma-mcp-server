import type { ProjectedNode, SimplePaint } from './node-projection.js';

export interface SpecNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Text content, hoisted regardless of how deep the TEXT layer sits. */
  readonly text?: string;
  /** For INSTANCE nodes: the component they instantiate. */
  readonly componentId?: string;
  /** Auto-layout sizing, which CSS cannot express without knowing the parent. */
  readonly sizing?: { readonly horizontal?: string; readonly vertical?: string };
  /** Ready-to-paste CSS declarations. */
  readonly css: Record<string, string>;
  /** Paints that do not map to a single CSS declaration (gradients, images). */
  readonly fills?: readonly SimplePaint[];
  readonly children?: readonly SpecNode[];
}

export interface SpecResult {
  readonly node: SpecNode;
  /** Content-free wrapper layers removed from the tree. */
  readonly collapsed: number;
  /** Ids of vector layers, whose shape only `figma_get_svg` can give you. */
  readonly vectors: readonly string[];
}

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON']);

/** Never collapsed: these map onto real code components, so their identity is the point. */
const STRUCTURAL_TYPES = new Set(['INSTANCE', 'COMPONENT', 'COMPONENT_SET']);

const ALIGNMENT: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
  BASELINE: 'baseline',
};

const TEXT_CASE: Record<string, string> = {
  UPPER: 'uppercase',
  LOWER: 'lowercase',
  TITLE: 'capitalize',
};

const TEXT_ALIGN: Record<string, string> = {
  CENTER: 'center',
  RIGHT: 'right',
  JUSTIFIED: 'justify',
};

/**
 * Figma reports derived measurements as raw floats: an item spacing of `318.010009765625`, a padding
 * of `1.1368683772161603e-13`. Rounding here keeps the emitted CSS readable and drops values that are
 * only noise from the layout engine.
 */
function px(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 100) / 100;
  return Math.abs(rounded) < 0.01 ? '0' : `${rounded}px`;
}

function isZero(value: string | undefined): boolean {
  return value === undefined || value === '0';
}

function num(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function firstSolid(paints: unknown): string | undefined {
  if (!Array.isArray(paints)) return undefined;
  for (const paint of paints as SimplePaint[]) {
    if (paint.type === 'SOLID' && 'color' in paint) return paint.color;
  }
  return undefined;
}

function nonSolid(paints: unknown): SimplePaint[] {
  if (!Array.isArray(paints)) return [];
  return (paints as SimplePaint[]).filter((paint) => paint.type !== 'SOLID');
}

function addLayout(css: Record<string, string>, layout: Record<string, unknown> | undefined): void {
  if (!layout) return;

  const mode = str(layout, 'layoutMode');
  if (mode === 'HORIZONTAL' || mode === 'VERTICAL') {
    css.display = 'flex';
    css['flex-direction'] = mode === 'HORIZONTAL' ? 'row' : 'column';
    if (str(layout, 'layoutWrap') === 'WRAP') css['flex-wrap'] = 'wrap';

    // Figma allows a negative item spacing to overlap children — the trick that collapses adjacent
    // 1px row borders. CSS `gap` cannot be negative, and a browser drops the declaration, so
    // emitting it would only be invalid output. The overlap is the child's `margin`, not the
    // parent's gap, and is left to the caller.
    const spacing = num(layout, 'itemSpacing');
    const gap = spacing !== undefined && spacing > 0 ? px(spacing) : undefined;
    if (!isZero(gap)) css.gap = gap as string;

    const primary = ALIGNMENT[str(layout, 'primaryAxisAlignItems') ?? ''];
    if (primary && primary !== 'flex-start') css['justify-content'] = primary;

    const counter = ALIGNMENT[str(layout, 'counterAxisAlignItems') ?? ''];
    if (counter && counter !== 'flex-start') css['align-items'] = counter;
  }

  const top = px(num(layout, 'paddingTop')) ?? '0';
  const right = px(num(layout, 'paddingRight')) ?? '0';
  const bottom = px(num(layout, 'paddingBottom')) ?? '0';
  const left = px(num(layout, 'paddingLeft')) ?? '0';
  if (![top, right, bottom, left].every(isZero)) {
    css.padding =
      top === bottom && left === right
        ? top === left
          ? top
          : `${top} ${right}`
        : `${top} ${right} ${bottom} ${left}`;
  }

  if (layout.clipsContent === true) css.overflow = 'hidden';
}

function addStyle(css: Record<string, string>, style: Record<string, unknown> | undefined, isText: boolean): void {
  if (!style) return;

  const fill = firstSolid(style.fills);
  if (fill) css[isText ? 'color' : 'background'] = fill;

  const stroke = firstSolid(style.strokes);
  if (stroke) {
    const sides = style.individualStrokeWeights as Record<string, unknown> | undefined;
    const perSide = sides
      ? (['top', 'right', 'bottom', 'left'] as const)
          .map((side) => ({ side, weight: px(num(sides, side)) }))
          .filter((entry) => !isZero(entry.weight))
      : [];

    if (sides && perSide.length > 0 && perSide.length < 4) {
      // Only some sides are drawn — an underlined tab, a row divider. A uniform `border` here
      // would box the element in and be visibly wrong.
      for (const { side, weight } of perSide) {
        css[`border-${side}`] = `${weight as string} solid ${stroke}`;
      }
    } else {
      const uniform = perSide[0]?.weight ?? px(num(style, 'strokeWeight')) ?? '1px';
      css.border = `${uniform === '0' ? '1px' : uniform} solid ${stroke}`;
    }
  }

  const radii = style.cornerRadii;
  if (Array.isArray(radii) && radii.length === 4) {
    css['border-radius'] = radii.map((value) => px(value) ?? '0').join(' ');
  } else {
    const radius = px(num(style, 'cornerRadius'));
    if (!isZero(radius)) css['border-radius'] = radius as string;
  }

  if (Array.isArray(style.effects)) {
    const shadows = (style.effects as Array<Record<string, unknown>>)
      .filter((effect) => effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW')
      .map((effect) => {
        const offset = (effect.offset ?? {}) as { x?: number; y?: number };
        const parts = [
          px(offset.x) ?? '0',
          px(offset.y) ?? '0',
          px(effect.radius) ?? '0',
          ...(num(effect, 'spread') ? [px(effect.spread) as string] : []),
          str(effect, 'color') ?? 'rgba(0,0,0,0.1)',
        ];
        return `${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${parts.join(' ')}`;
      });
    if (shadows.length > 0) css['box-shadow'] = shadows.join(', ');
  }

  const opacity = num(style, 'opacity');
  if (opacity !== undefined && opacity < 1) css.opacity = String(Math.round(opacity * 100) / 100);
}

function addFont(css: Record<string, string>, font: Record<string, unknown> | undefined): void {
  if (!font) return;

  const family = str(font, 'fontFamily');
  if (family) css['font-family'] = family;

  const weight = num(font, 'fontWeight');
  if (weight !== undefined) css['font-weight'] = String(weight);

  const size = px(num(font, 'fontSize'));
  if (size) css['font-size'] = size;

  const lineHeight = px(num(font, 'lineHeightPx'));
  if (lineHeight) css['line-height'] = lineHeight;

  const spacing = px(num(font, 'letterSpacing'));
  if (!isZero(spacing)) css['letter-spacing'] = spacing as string;

  const textCase = TEXT_CASE[str(font, 'textCase') ?? ''];
  if (textCase) css['text-transform'] = textCase;

  const align = TEXT_ALIGN[str(font, 'textAlignHorizontal') ?? ''];
  if (align) css['text-align'] = align;

  if (str(font, 'textDecoration') === 'UNDERLINE') css['text-decoration'] = 'underline';
}

/** Declarations that describe nothing on their own: a flex container with one child and no spacing. */
const NO_OP_CSS = new Set(['display', 'flex-direction', 'justify-content', 'align-items']);

function isWrapper(node: SpecNode): boolean {
  return (
    !STRUCTURAL_TYPES.has(node.type) &&
    node.text === undefined &&
    node.children?.length === 1 &&
    node.fills === undefined &&
    // `width`/`height` are only emitted for a FIXED axis, so a sized wrapper keeps its level.
    Object.keys(node.css).every((property) => NO_OP_CSS.has(property))
  );
}

function toSpec(node: ProjectedNode, isRoot: boolean, result: { collapsed: number; vectors: string[] }): SpecNode {
  const css: Record<string, string> = {};
  addLayout(css, node.layout);
  addStyle(css, node.style, node.type === 'TEXT');
  addFont(css, node.font);

  // Only a FIXED axis has a size CSS can state; FILL and HUG depend on the parent, so they are
  // reported separately rather than guessed at as `width: 100%`.
  const horizontal = str(node.layout, 'layoutSizingHorizontal');
  const vertical = str(node.layout, 'layoutSizingVertical');
  if (node.bounds) {
    if (isRoot || horizontal === 'FIXED') css.width = `${node.bounds.width}px`;
    if (isRoot || vertical === 'FIXED') css.height = `${node.bounds.height}px`;
  }

  if (VECTOR_TYPES.has(node.type)) result.vectors.push(node.id);

  const children = (node.children ?? []).map((child) => toSpec(child, false, result));
  const gradients = nonSolid(node.style?.fills);

  const sizing = {
    ...(horizontal && horizontal !== 'FIXED' ? { horizontal } : {}),
    ...(vertical && vertical !== 'FIXED' ? { vertical } : {}),
  };

  const spec: SpecNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.componentId !== undefined ? { componentId: node.componentId } : {}),
    ...(Object.keys(sizing).length > 0 ? { sizing } : {}),
    css,
    ...(gradients.length > 0 ? { fills: gradients } : {}),
    ...(children.length > 0 ? { children } : {}),
  };

  // A wrapper adds a level of nesting and nothing else. Figma files are full of them
  // (`Data > Margin > Container > Container > TEXT`), and each one pushes the content a caller
  // actually wants further out of reach of any depth limit.
  if (!isRoot && isWrapper(spec)) {
    result.collapsed += 1;
    return (spec.children as SpecNode[])[0] as SpecNode;
  }
  return spec;
}

/** Turns a projected layer tree into a flattened, code-ready spec. */
export function buildSpec(node: ProjectedNode): SpecResult {
  const result = { collapsed: 0, vectors: [] as string[] };
  const spec = toSpec(node, true, result);
  return { node: spec, collapsed: result.collapsed, vectors: result.vectors };
}

/** Renders a spec node's declarations as a CSS rule body. */
export function cssText(css: Record<string, string>): string {
  return Object.entries(css)
    .map(([property, value]) => `${property}: ${value};`)
    .join(' ');
}

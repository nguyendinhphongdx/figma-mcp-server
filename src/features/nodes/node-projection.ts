import type { FigmaNode } from '../../core/figma/figma-api.js';
import { simplifyPaints, toHex, type Rgba, type SimplePaint } from '../shared/color.js';

export type IncludeGroup = 'layout' | 'style' | 'text';

export interface ProjectedNode {
  id: string;
  name: string;
  type: string;
  /** Only present when the node is hidden. */
  visible?: false;
  bounds?: { x: number; y: number; width: number; height: number };
  /** Text content of TEXT nodes (truncated). */
  text?: string;
  /** For INSTANCE nodes: the component they instantiate. */
  componentId?: string;
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
  font?: Record<string, unknown>;
  children?: ProjectedNode[];
}

export interface ProjectionBudget {
  remaining: number;
  truncated: boolean;
}

const MAX_TEXT_LENGTH = 200;

const LAYOUT_FIELDS = [
  'layoutMode',
  'layoutWrap',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'clipsContent',
] as const;

const FONT_FIELDS = [
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeightPx',
  'lineHeightPercentFontSize',
  'letterSpacing',
  'textAlignHorizontal',
  'textCase',
  'textDecoration',
] as const;

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      picked[field] = source[field];
    }
  }
  return picked;
}

function projectStyle(node: FigmaNode): Record<string, unknown> {
  const style: Record<string, unknown> = {};

  const fills = simplifyPaints(node.fills);
  if (fills.length > 0) style.fills = fills;

  const strokes = simplifyPaints(node.strokes);
  if (strokes.length > 0) {
    style.strokes = strokes;
    if (typeof node.strokeWeight === 'number') style.strokeWeight = node.strokeWeight;
  }

  if (Array.isArray(node.effects) && node.effects.length > 0) {
    style.effects = (node.effects as Array<Record<string, unknown>>)
      .filter((effect) => effect.visible !== false)
      .map((effect) => ({
        type: effect.type,
        ...(effect.color ? { color: toHex(effect.color as Rgba) } : {}),
        ...(effect.offset ? { offset: effect.offset } : {}),
        ...(effect.radius !== undefined ? { radius: effect.radius } : {}),
        ...(effect.spread !== undefined ? { spread: effect.spread } : {}),
      }));
  }

  if (node.rectangleCornerRadii) style.cornerRadii = node.rectangleCornerRadii;
  else if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) style.cornerRadius = node.cornerRadius;
  if (typeof node.opacity === 'number' && node.opacity < 1) style.opacity = node.opacity;
  return style;
}

/**
 * Reduces a raw Figma node tree to what design/implementation work needs.
 * Raw nodes carry dozens of fields per layer (geometry, plugin data, ...), which would burn a
 * model's context for nothing; this keeps identity, bounds, text and the requested groups.
 */
export function projectNode(
  node: FigmaNode,
  depthRemaining: number,
  include: ReadonlySet<IncludeGroup>,
  budget: ProjectionBudget,
): ProjectedNode {
  budget.remaining -= 1;

  const projected: ProjectedNode = { id: node.id, name: node.name, type: node.type };
  if (node.visible === false) projected.visible = false;

  const box = node.absoluteBoundingBox;
  if (box) {
    projected.bounds = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }

  if (node.type === 'TEXT' && typeof node.characters === 'string') {
    projected.text =
      node.characters.length > MAX_TEXT_LENGTH ? `${node.characters.slice(0, MAX_TEXT_LENGTH)}...` : node.characters;
    if (include.has('text') && node.style && typeof node.style === 'object') {
      projected.font = pick(node.style as Record<string, unknown>, FONT_FIELDS);
    }
  }
  if (node.type === 'INSTANCE' && typeof node.componentId === 'string') {
    projected.componentId = node.componentId;
  }
  if (include.has('layout')) {
    const layout = pick(node, LAYOUT_FIELDS);
    if (Object.keys(layout).length > 0) projected.layout = layout;
  }
  if (include.has('style')) {
    const style = projectStyle(node);
    if (Object.keys(style).length > 0) projected.style = style;
  }

  const children = node.children ?? [];
  if (children.length > 0 && depthRemaining > 0) {
    projected.children = [];
    for (const child of children) {
      if (budget.remaining <= 0) {
        budget.truncated = true;
        break;
      }
      projected.children.push(projectNode(child, depthRemaining - 1, include, budget));
    }
  } else if (children.length > 0) {
    // Depth limit reached: signal that there is more below without spending tokens on it.
    projected.children = [];
  }
  return projected;
}

export type { SimplePaint };

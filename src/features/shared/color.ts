export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

function channel(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** Figma colours are 0-1 floats; returns `#rrggbb`, or `#rrggbbaa` when not fully opaque. */
export function toHex(color: Rgba, extraOpacity = 1): string {
  const alpha = (color.a ?? 1) * extraOpacity;
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return alpha >= 0.999 ? base : `${base}${channel(alpha)}`;
}

export interface PaintLike {
  readonly type?: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly color?: Rgba;
  readonly gradientStops?: ReadonlyArray<{ readonly position: number; readonly color: Rgba }>;
  readonly scaleMode?: string;
}

export type SimplePaint =
  | { readonly type: 'SOLID'; readonly color: string }
  | {
      readonly type: string;
      readonly stops: ReadonlyArray<{ readonly position: number; readonly color: string }>;
    }
  | { readonly type: string; readonly scaleMode?: string };

/** Reduces a Figma paint to the few fields that matter for design work. Hidden paints are dropped. */
export function simplifyPaints(paints: unknown): SimplePaint[] {
  if (!Array.isArray(paints)) {
    return [];
  }
  const result: SimplePaint[] = [];
  for (const paint of paints as PaintLike[]) {
    if (paint.visible === false || !paint.type) continue;
    if (paint.type === 'SOLID' && paint.color) {
      result.push({ type: 'SOLID', color: toHex(paint.color, paint.opacity ?? 1) });
    } else if (paint.type.startsWith('GRADIENT') && paint.gradientStops) {
      result.push({
        type: paint.type,
        stops: paint.gradientStops.map((stop) => ({
          position: Number(stop.position.toFixed(3)),
          color: toHex(stop.color, paint.opacity ?? 1),
        })),
      });
    } else {
      result.push(paint.scaleMode ? { type: paint.type, scaleMode: paint.scaleMode } : { type: paint.type });
    }
  }
  return result;
}

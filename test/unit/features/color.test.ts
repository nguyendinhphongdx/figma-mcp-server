import { describe, expect, it } from 'vitest';
import { simplifyPaints, toHex } from '../../../src/features/shared/color.js';

describe('toHex', () => {
  it('converts Figma 0-1 floats to #rrggbb', () => {
    expect(toHex({ r: 1, g: 0, b: 0 })).toBe('#ff0000');
    expect(toHex({ r: 0.102, g: 0.4, b: 0.902, a: 1 })).toBe('#1a66e6');
  });

  it('appends alpha only when not opaque, folding in extra opacity', () => {
    expect(toHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
    expect(toHex({ r: 1, g: 1, b: 1 }, 0.5)).toBe('#ffffff80');
  });

  it('clamps out-of-range channels', () => {
    expect(toHex({ r: 2, g: -1, b: 0.5 })).toBe('#ff0080');
  });
});

describe('simplifyPaints', () => {
  it('reduces solid, gradient and image paints and drops hidden ones', () => {
    const result = simplifyPaints([
      { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } },
      { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, visible: false },
      {
        type: 'GRADIENT_LINEAR',
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 0.33333, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
      { type: 'IMAGE', scaleMode: 'FILL' },
    ]);
    expect(result).toEqual([
      { type: 'SOLID', color: '#000000' },
      { type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: '#ff0000' }, { position: 0.333, color: '#0000ff' }] },
      { type: 'IMAGE', scaleMode: 'FILL' },
    ]);
  });

  it('applies paint opacity and tolerates non-arrays', () => {
    expect(simplifyPaints([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }])).toEqual([
      { type: 'SOLID', color: '#00000080' },
    ]);
    expect(simplifyPaints(undefined)).toEqual([]);
    expect(simplifyPaints('nope')).toEqual([]);
  });
});

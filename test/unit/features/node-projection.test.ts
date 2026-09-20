import { describe, expect, it } from 'vitest';
import type { FigmaNode } from '../../../src/core/figma/figma-api.js';
import { projectNode, type IncludeGroup } from '../../../src/features/nodes/node-projection.js';

const ALL: ReadonlySet<IncludeGroup> = new Set(['layout', 'style', 'text']);
const NONE: ReadonlySet<IncludeGroup> = new Set();
const budget = (remaining = 1_000) => ({ remaining, truncated: false });

const node = (overrides: Record<string, unknown>): FigmaNode => ({ id: '1:1', name: 'N', type: 'FRAME', ...overrides }) as FigmaNode;

describe('projectNode', () => {
  it('keeps identity and rounded bounds only when no groups are requested', () => {
    const projected = projectNode(
      node({ absoluteBoundingBox: { x: 0.4, y: 10.6, width: 100.5, height: 20 }, layoutMode: 'VERTICAL', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }),
      5,
      NONE,
      budget(),
    );
    expect(projected).toEqual({ id: '1:1', name: 'N', type: 'FRAME', bounds: { x: 0, y: 11, width: 101, height: 20 } });
  });

  it('adds layout fields, skipping null/undefined ones', () => {
    const projected = projectNode(node({ layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: null, unrelated: 1 }), 5, new Set(['layout']), budget());
    expect(projected.layout).toEqual({ layoutMode: 'HORIZONTAL', itemSpacing: 8 });
  });

  it('adds simplified fills, strokes, visible effects, radius and opacity under "style"', () => {
    const projected = projectNode(
      node({
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeWeight: 2,
        effects: [
          { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8 },
          { type: 'LAYER_BLUR', visible: false, radius: 3 },
        ],
        cornerRadius: 12,
        opacity: 0.8,
      }),
      5,
      new Set(['style']),
      budget(),
    );
    expect(projected.style).toEqual({
      fills: [{ type: 'SOLID', color: '#ffffff' }],
      strokes: [{ type: 'SOLID', color: '#000000' }],
      strokeWeight: 2,
      effects: [{ type: 'DROP_SHADOW', color: '#00000040', offset: { x: 0, y: 4 }, radius: 8 }],
      cornerRadius: 12,
      opacity: 0.8,
    });
  });

  it('prefers per-corner radii, and omits zero radius and full opacity', () => {
    const uneven = projectNode(node({ rectangleCornerRadii: [1, 2, 3, 4], cornerRadius: 9 }), 1, new Set(['style']), budget());
    expect(uneven.style).toEqual({ cornerRadii: [1, 2, 3, 4] });
    const plain = projectNode(node({ cornerRadius: 0, opacity: 1 }), 1, new Set(['style']), budget());
    expect(plain.style).toBeUndefined();
  });

  it('exposes text content always, and the font only for the "text" group; drops unrelated font fields', () => {
    const text = node({ type: 'TEXT', characters: 'Hello', style: { fontFamily: 'Inter', fontSize: 16, hyperlink: 'x' } });
    expect(projectNode(text, 1, NONE, budget())).toMatchObject({ text: 'Hello' });
    expect(projectNode(text, 1, NONE, budget()).font).toBeUndefined();
    expect(projectNode(text, 1, new Set(['text']), budget()).font).toEqual({ fontFamily: 'Inter', fontSize: 16 });
  });

  it('truncates very long text', () => {
    const projected = projectNode(node({ type: 'TEXT', characters: 'x'.repeat(500) }), 1, NONE, budget());
    expect(projected.text).toBe(`${'x'.repeat(200)}...`);
  });

  it('marks hidden nodes and records the component of an instance', () => {
    expect(projectNode(node({ visible: false }), 1, NONE, budget()).visible).toBe(false);
    expect(projectNode(node({ visible: true }), 1, NONE, budget()).visible).toBeUndefined();
    expect(projectNode(node({ type: 'INSTANCE', componentId: '3:1' }), 1, NONE, budget()).componentId).toBe('3:1');
  });

  describe('depth and budget', () => {
    const tree = node({
      id: 'root',
      children: [
        node({ id: 'a', children: [node({ id: 'a1' }), node({ id: 'a2' })] }),
        node({ id: 'b' }),
      ],
    });

    it('projects the whole tree when limits allow, counting every node', () => {
      const b = budget();
      const projected = projectNode(tree, 5, NONE, b);
      expect(projected.children?.map((c) => c.id)).toEqual(['a', 'b']);
      expect(projected.children?.[0]?.children?.map((c) => c.id)).toEqual(['a1', 'a2']);
      expect(b).toEqual({ remaining: 1_000 - 5, truncated: false });
    });

    it('at the depth limit, signals hidden children with an empty array instead of descending', () => {
      const projected = projectNode(tree, 1, NONE, budget());
      expect(projected.children?.[0]?.id).toBe('a');
      expect(projected.children?.[0]?.children).toEqual([]);
      expect(projectNode(tree, 0, NONE, budget()).children).toEqual([]);
    });

    it('leaf nodes carry no children key at all', () => {
      expect('children' in projectNode(node({}), 3, NONE, budget())).toBe(false);
    });

    it('stops when the node budget runs out and says so', () => {
      const b = budget(3); // root + a + a1
      const projected = projectNode(tree, 5, NONE, b);
      expect(b.truncated).toBe(true);
      const ids: string[] = [];
      const walk = (n: { id: string; children?: Array<{ id: string; children?: unknown[] }> }): void => {
        ids.push(n.id);
        n.children?.forEach((c) => walk(c as never));
      };
      walk(projected);
      expect(ids).toEqual(['root', 'a', 'a1']);
    });
  });
});

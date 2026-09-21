import { describe, expect, it } from 'vitest';
import { projectNode, type ProjectedNode } from '../../../src/features/nodes/node-projection.js';
import { buildSpec, cssText } from '../../../src/features/nodes/node-spec.js';
import { minifySvg } from '../../../src/features/export/get-svg.js';

function project(node: Record<string, unknown>): ProjectedNode {
  return projectNode(node as never, 10, new Set(['layout', 'style', 'text']), { remaining: 500, truncated: false });
}

const BUTTON = {
  id: '1:1',
  name: 'Button',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 196, height: 36 },
  layoutMode: 'HORIZONTAL',
  counterAxisAlignItems: 'CENTER',
  layoutSizingHorizontal: 'HUG',
  itemSpacing: 8,
  paddingLeft: 16,
  paddingRight: 16,
  paddingTop: 8,
  paddingBottom: 8,
  cornerRadius: 8,
  fills: [{ type: 'SOLID', color: { r: 0.145, g: 0.388, b: 0.922, a: 1 } }],
  children: [
    {
      id: '1:2',
      name: 'Label',
      type: 'TEXT',
      characters: 'Tạo vai trò tùy chỉnh',
      absoluteBoundingBox: { x: 16, y: 8, width: 136, height: 20 },
      style: { fontFamily: 'Inter', fontWeight: 500, fontSize: 14, lineHeightPx: 20, letterSpacing: 0, textCase: 'UPPER' },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    },
  ],
};

describe('buildSpec', () => {
  it('emits CSS declarations for auto-layout, paint and type', () => {
    const { node } = buildSpec(project(BUTTON));

    expect(node.css).toMatchObject({
      display: 'flex',
      'flex-direction': 'row',
      'align-items': 'center',
      gap: '8px',
      padding: '8px 16px',
      'border-radius': '8px',
      background: '#2563eb',
    });

    const label = node.children?.[0];
    expect(label?.text).toBe('Tạo vai trò tùy chỉnh');
    expect(label?.css).toMatchObject({
      color: '#ffffff',
      'font-family': 'Inter',
      'font-weight': '500',
      'font-size': '14px',
      'line-height': '20px',
      'text-transform': 'uppercase',
    });
    // letterSpacing 0 is noise, not a declaration.
    expect(label?.css['letter-spacing']).toBeUndefined();
  });

  it('reports non-FIXED axes as sizing instead of guessing a width', () => {
    const { node } = buildSpec(project(BUTTON));
    expect(node.sizing).toEqual({ horizontal: 'HUG' });
    // The root always states its measured size.
    expect(node.css.width).toBe('196px');
  });

  it('collapses content-free wrappers so text is not buried', () => {
    const { node, collapsed } = buildSpec(
      project({
        id: '1:1',
        name: 'Data',
        type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        children: [
          {
            id: '1:2',
            name: 'Margin',
            type: 'FRAME',
            layoutMode: 'VERTICAL',
            children: [
              {
                id: '1:3',
                name: 'Container',
                type: 'FRAME',
                children: [{ id: '1:4', name: 'Value', type: 'TEXT', characters: 'Tổ chức' }],
              },
            ],
          },
        ],
      }),
    );

    expect(collapsed).toBe(2);
    expect(node.children).toHaveLength(1);
    expect(node.children?.[0]).toMatchObject({ id: '1:4', type: 'TEXT', text: 'Tổ chức' });
  });

  it('keeps wrappers that carry padding, paint or a fixed size', () => {
    const { collapsed } = buildSpec(
      project({
        id: '1:1',
        name: 'Card',
        type: 'FRAME',
        children: [
          {
            id: '1:2',
            name: 'Padded',
            type: 'FRAME',
            paddingLeft: 24,
            children: [{ id: '1:3', name: 'Text', type: 'TEXT', characters: 'x' }],
          },
        ],
      }),
    );
    expect(collapsed).toBe(0);
  });

  it('never collapses an instance, because it maps onto a code component', () => {
    const { node, collapsed } = buildSpec(
      project({
        id: '1:1',
        name: 'Row',
        type: 'FRAME',
        children: [
          {
            id: '1:2',
            name: 'Button/Primary',
            type: 'INSTANCE',
            componentId: '3:1',
            children: [{ id: '1:3', name: 'Label', type: 'TEXT', characters: 'Save' }],
          },
        ],
      }),
    );
    expect(collapsed).toBe(0);
    expect(node.children?.[0]).toMatchObject({ id: '1:2', componentId: '3:1' });
  });

  it('rounds away the float noise Figma reports for derived spacing', () => {
    const { node } = buildSpec(
      project({
        id: '1:1',
        name: 'Action Bar',
        type: 'FRAME',
        layoutMode: 'HORIZONTAL',
        primaryAxisAlignItems: 'SPACE_BETWEEN',
        itemSpacing: 318.010009765625,
        paddingRight: 1.1368683772161603e-13,
      }),
    );
    expect(node.css.gap).toBe('318.01px');
    expect(node.css['justify-content']).toBe('space-between');
    // A padding of 1.1e-13 is the layout engine's rounding, not a design decision.
    expect(node.css.padding).toBeUndefined();
  });

  it('turns strokes and shadows into border and box-shadow', () => {
    const { node } = buildSpec(
      project({
        id: '1:1',
        name: 'Card',
        type: 'FRAME',
        strokes: [{ type: 'SOLID', color: { r: 196 / 255, g: 199 / 255, b: 197 / 255, a: 1 } }],
        strokeWeight: 1,
        effects: [
          { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.05 }, offset: { x: 0, y: 1 }, radius: 2 },
        ],
      }),
    );
    expect(node.css.border).toBe('1px solid #c4c7c5');
    expect(node.css['box-shadow']).toBe('0 1px 2px #0000000d');
  });

  it('emits a one-sided border when only one side is stroked', () => {
    const { node } = buildSpec(
      project({
        id: '1:1',
        name: 'Link',
        type: 'FRAME',
        strokes: [{ type: 'SOLID', color: { r: 26 / 255, g: 115 / 255, b: 232 / 255, a: 1 } }],
        strokeWeight: 2,
        individualStrokeWeights: { top: 0, right: 0, bottom: 2, left: 0 },
      }),
    );
    // A uniform `border` would box the tab in; the design only underlines it.
    expect(node.css['border-bottom']).toBe('2px solid #1a73e8');
    expect(node.css.border).toBeUndefined();
    expect(node.css['border-top']).toBeUndefined();
  });

  it('still emits a uniform border when every side is stroked', () => {
    const { node } = buildSpec(
      project({
        id: '1:1',
        name: 'Card',
        type: 'FRAME',
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        strokeWeight: 1,
        individualStrokeWeights: { top: 1, right: 1, bottom: 1, left: 1 },
      }),
    );
    expect(node.css.border).toBe('1px solid #000000');
  });

  it('drops a negative gap, which CSS has no way to express', () => {
    const { node } = buildSpec(
      project({
        id: '1:1',
        name: 'Body',
        type: 'FRAME',
        layoutMode: 'VERTICAL',
        // Figma's trick for collapsing adjacent 1px row borders.
        itemSpacing: -1,
      }),
    );
    expect(node.css.gap).toBeUndefined();
    expect(node.css.display).toBe('flex');
  });

  it('flags vector layers, whose shape only figma_get_svg can supply', () => {
    const { vectors } = buildSpec(
      project({
        id: '1:1',
        name: 'Icon',
        type: 'FRAME',
        children: [{ id: '1:2', name: 'Vector', type: 'VECTOR' }],
      }),
    );
    expect(vectors).toEqual(['1:2']);
  });
});

describe('cssText', () => {
  it('renders declarations as a rule body', () => {
    expect(cssText({ display: 'flex', gap: '8px' })).toBe('display: flex; gap: 8px;');
  });
});

describe('minifySvg', () => {
  it('drops the XML prologue and inter-tag whitespace', () => {
    expect(minifySvg('<?xml version="1.0"?>\n<svg>\n  <path d="M2 8h12"/>\n</svg>')).toBe(
      '<svg><path d="M2 8h12"/></svg>',
    );
  });
});

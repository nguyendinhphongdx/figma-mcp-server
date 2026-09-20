import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../../src/core/domain/errors.js';
import { normalizeNodeId, parseFigmaUrl, parseNodeInput, resolveFileKey } from '../../../src/core/domain/figma-ref.js';

describe('normalizeNodeId', () => {
  it.each([
    ['1:2', '1:2'],
    ['1-2', '1:2'],
    ['  123:456 ', '123:456'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeNodeId(raw)).toBe(expected);
  });

  it.each(['', 'abc', '1', '1:', ':2', '1:2:3', '1_2', '1;2'])('rejects "%s"', (raw) => {
    expect(() => normalizeNodeId(raw)).toThrow(InvalidInputError);
  });
});

describe('parseFigmaUrl', () => {
  it('reads key and node id from a design URL (node-id uses dashes)', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbC123xyz90/My-App?node-id=12-34&t=zzz')).toEqual({
      fileKey: 'AbC123xyz90',
      nodeId: '12:34',
    });
  });

  it.each(['design', 'file', 'proto', 'board'])('understands /%s/ URLs', (kind) => {
    expect(parseFigmaUrl(`https://figma.com/${kind}/KEY1234567/Name`).fileKey).toBe('KEY1234567');
  });

  it('uses the branch key for branch URLs', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/MAINKEY123/branch/BRANCHKEY9/Name').fileKey).toBe('BRANCHKEY9');
  });

  it('omits nodeId when the URL has none', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/KEY1234567/Name')).toEqual({ fileKey: 'KEY1234567' });
  });

  it.each([
    ['not a URL', 'hello'],
    ['another site', 'https://example.com/design/KEY1234567/x'],
    ['host that merely ends in figma.com', 'https://notfigma.com/design/KEY1234567/x'],
    ['no key in path', 'https://www.figma.com/community/plugin/1'],
    ['bad node-id', 'https://www.figma.com/design/KEY1234567/x?node-id=oops'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseFigmaUrl(raw)).toThrow(InvalidInputError);
  });
});

describe('resolveFileKey', () => {
  it('passes a bare key through and trims it', () => {
    expect(resolveFileKey('  AbC123xyz90 ')).toBe('AbC123xyz90');
  });

  it('extracts the key from a URL', () => {
    expect(resolveFileKey('https://www.figma.com/file/AbC123xyz90/x')).toBe('AbC123xyz90');
  });

  it.each(['short', 'has space in it 123', 'bad/key/12345', ''])('rejects "%s"', (raw) => {
    expect(() => resolveFileKey(raw)).toThrow(InvalidInputError);
  });
});

describe('parseNodeInput', () => {
  it('accepts a bare node id in either form', () => {
    expect(parseNodeInput('1-2')).toEqual({ nodeId: '1:2' });
    expect(parseNodeInput('1:2')).toEqual({ nodeId: '1:2' });
  });

  it('takes both file and node from a frame link', () => {
    expect(parseNodeInput('https://www.figma.com/design/KEY1234567/x?node-id=5-6')).toEqual({
      fileKey: 'KEY1234567',
      nodeId: '5:6',
    });
  });

  it('explains what to do when the link has no node-id', () => {
    expect(() => parseNodeInput('https://www.figma.com/design/KEY1234567/x')).toThrow(/no node-id/);
  });
});

import { describe, expect, it } from 'vitest';
import { buildFileName, sanitizeName } from '../../../src/core/storage/file-namer.js';

describe('sanitizeName', () => {
  it('keeps Unicode letters (Vietnamese layer names stay readable)', () => {
    expect(sanitizeName('Đăng nhập')).toBe('Đăng nhập');
  });

  it('normalises decomposed Unicode to NFC', () => {
    expect(sanitizeName('Đăng')).toBe('Đăng');
  });

  it('replaces characters illegal on Windows/macOS/Linux', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('replaces control characters and collapses whitespace', () => {
    expect(sanitizeName('a\u0000b\n\tc   d')).toBe('a_b__c d');
  });

  it('cannot produce path traversal or hidden files', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeName('..')).toBe('');
    expect(sanitizeName('.hidden.')).toBe('hidden');
  });

  it('avoids Windows reserved device names', () => {
    expect(sanitizeName('CON')).toBe('_CON');
    expect(sanitizeName('lpt1')).toBe('_lpt1');
    expect(sanitizeName('console')).toBe('console');
  });

  it('truncates long names by characters, not UTF-16 units', () => {
    const long = '😀'.repeat(200);
    expect(Array.from(sanitizeName(long))).toHaveLength(80);
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(sanitizeName('   ')).toBe('');
    expect(sanitizeName('...')).toBe('');
  });
});

describe('buildFileName', () => {
  it('combines name and id, turning the id colon into a dash', () => {
    expect(buildFileName({ id: '1:23', name: 'Welcome' }, 'jpg')).toBe('Welcome__1-23.jpg');
  });

  it('falls back to the id alone', () => {
    expect(buildFileName({ id: '1:23' }, 'png')).toBe('1-23.png');
    expect(buildFileName({ id: '1:23', name: '   ' }, 'svg')).toBe('1-23.svg');
  });

  it('keeps names unique when frames share a layer name', () => {
    const a = buildFileName({ id: '1:1', name: 'Card' }, 'jpg');
    const b = buildFileName({ id: '1:2', name: 'Card' }, 'jpg');
    expect(a).not.toBe(b);
  });
});

import { describe, expect, it } from 'vitest';
import { listDocs, readDoc } from '../../../src/adapters/http/docs-content.js';

describe('listDocs', () => {
  it('lists the pages in reading order, not alphabetically', async () => {
    const slugs = (await listDocs()).map((doc) => doc.slug);
    expect(slugs).toEqual(['getting-started', 'tools', 'design-to-code', 'rate-limits', 'architecture']);
  });

  it('gives every page a title and an icon', async () => {
    for (const doc of await listDocs()) {
      expect(doc.title).not.toBe('');
      expect(doc.icon).toMatch(/^&#\d+;$/);
    }
  });

  it('can actually read every page it lists', async () => {
    for (const doc of await listDocs()) {
      const body = await readDoc(doc.slug);
      expect(body, `${doc.slug} is listed but unreadable`).toBeTruthy();
      expect(body).toMatch(/^# /);
    }
  });
});

describe('readDoc', () => {
  it('refuses anything that is not a plain slug', async () => {
    expect(await readDoc('../../../package.json')).toBeUndefined();
    expect(await readDoc('getting started')).toBeUndefined();
    expect(await readDoc('Tools')).toBeUndefined();
  });

  it('returns undefined for a slug that does not exist', async () => {
    expect(await readDoc('nope')).toBeUndefined();
  });
});

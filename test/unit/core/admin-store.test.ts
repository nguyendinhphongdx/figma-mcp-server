import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminStore } from '../../../src/core/admin/admin-store.js';
import { hashApiKey } from '../../../src/core/security/api-keys.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'admin-store-test-'));
  filePath = join(dir, 'admin.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AdminStore', () => {
  it('starts empty when there is no file yet', () => {
    const store = new AdminStore(filePath);
    expect(store.getFigmaToken()).toBe('');
    expect(store.getApiKeyHashes().size).toBe(0);
    expect(store.hasAdmin()).toBe(false);
  });

  it('seeds from env only on first run, and never overwrites existing state', () => {
    const store = new AdminStore(filePath);
    store.seedFromEnv('figd_seed_token', new Map([['alice', hashApiKey('key-a')]]));
    expect(store.getFigmaToken()).toBe('figd_seed_token');
    expect([...store.getApiKeyHashes().keys()]).toEqual(['alice']);

    store.setFigmaToken('figd_changed');
    store.seedFromEnv('figd_seed_token', new Map([['bob', hashApiKey('key-b')]]));
    expect(store.getFigmaToken()).toBe('figd_changed');
    expect([...store.getApiKeyHashes().keys()]).toEqual(['alice']);
  });

  it('persists across reloads', () => {
    new AdminStore(filePath).setFigmaToken('figd_persisted');
    expect(new AdminStore(filePath).getFigmaToken()).toBe('figd_persisted');
  });

  it('adds, lists and removes users, generating a fresh key each time', () => {
    const store = new AdminStore(filePath);
    const added = store.addUser('alice');
    expect(added.name).toBe('alice');
    expect(store.listUsers()).toEqual([{ name: 'alice' }]);
    expect(store.getApiKeyHashes().get('alice')).toBe(hashApiKey(added.key));

    expect(store.removeUser('alice')).toBe(true);
    expect(store.removeUser('alice')).toBe(false);
    expect(store.listUsers()).toEqual([]);
  });

  it('re-adding a user replaces their old key', () => {
    const store = new AdminStore(filePath);
    const first = store.addUser('alice');
    const second = store.addUser('alice');
    expect(store.listUsers()).toEqual([{ name: 'alice' }]);
    expect(store.getApiKeyHashes().get('alice')).toBe(hashApiKey(second.key));
    expect(store.getApiKeyHashes().get('alice')).not.toBe(hashApiKey(first.key));
  });

  it('sets up the admin account once and verifies credentials thereafter', () => {
    const store = new AdminStore(filePath);
    expect(store.hasAdmin()).toBe(false);
    store.setupAdmin('root', 'a-strong-password');
    expect(store.hasAdmin()).toBe(true);
    expect(store.verifyAdmin('root', 'a-strong-password')).toBe(true);
    expect(store.verifyAdmin('root', 'wrong-password')).toBe(false);
    expect(store.verifyAdmin('nobody', 'a-strong-password')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/core/admin/sessions.js';

describe('SessionStore', () => {
  it('creates a token that verifies to the right username', () => {
    const sessions = new SessionStore(() => 1000);
    const token = sessions.create('root');
    expect(sessions.verify(token)).toBe('root');
  });

  it('rejects a missing or unknown token', () => {
    const sessions = new SessionStore(() => 1000);
    expect(sessions.verify(undefined)).toBeUndefined();
    expect(sessions.verify('not-a-real-token')).toBeUndefined();
  });

  it('expires a session after its TTL', () => {
    let now = 0;
    const sessions = new SessionStore(() => now);
    const token = sessions.create('root');
    now = 12 * 60 * 60 * 1000 - 1;
    expect(sessions.verify(token)).toBe('root');
    now = 12 * 60 * 60 * 1000 + 1;
    expect(sessions.verify(token)).toBeUndefined();
  });

  it('destroy invalidates a session immediately', () => {
    const sessions = new SessionStore(() => 0);
    const token = sessions.create('root');
    sessions.destroy(token);
    expect(sessions.verify(token)).toBeUndefined();
  });

  it('sweep removes only expired sessions and reports how many', () => {
    let now = 0;
    const sessions = new SessionStore(() => now);
    const stale = sessions.create('a');
    now = 1000;
    const fresh = sessions.create('b');
    now = 12 * 60 * 60 * 1000 + 1;
    expect(sessions.sweep()).toBe(1);
    expect(sessions.verify(stale)).toBeUndefined();
    expect(sessions.verify(fresh)).toBe('b');
  });
});

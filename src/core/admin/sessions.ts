import { randomBytes } from 'node:crypto';

interface Session {
  readonly username: string;
  readonly expiresAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

/** In-memory admin session store. Fits the same single-process model already used by the
 * rate-limit governor; sessions are lost on restart, which just means logging in again. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly clock: () => number = Date.now) {}

  create(username: string): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.sessions.set(token, { username, expiresAt: this.clock() + SESSION_TTL_MS });
    return token;
  }

  /** Returns the session's username, or undefined if the token is missing or expired. */
  verify(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= this.clock()) {
      if (session) this.sessions.delete(token);
      return undefined;
    }
    return session.username;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Removes expired sessions; returns how many were removed. */
  sweep(): number {
    const now = this.clock();
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

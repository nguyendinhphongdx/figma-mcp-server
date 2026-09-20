import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateApiKey } from '../security/api-keys.js';

interface AdminAccount {
  readonly username: string;
  readonly passwordHash: string;
  readonly salt: string;
}

interface StoredUser {
  readonly name: string;
  readonly hash: string;
}

interface StoredState {
  figmaToken: string;
  users: StoredUser[];
  admin: AdminAccount | null;
}

export interface AddedUser {
  readonly key: string;
  readonly name: string;
}

const SCRYPT_KEY_LENGTH = 64;

function emptyState(): StoredState {
  return { figmaToken: '', users: [], admin: null };
}

/**
 * Hot-reloadable source of truth for the Figma token, MCP users and the admin account,
 * backed by a single JSON file. Reads never touch disk (the file is only the persistence
 * layer for an in-memory copy); writes persist synchronously before returning so a crash
 * right after a call can never lose it.
 */
export class AdminStore {
  private state: StoredState;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  /** Seeds the store from env-provided values, but only if it has never been configured
   * (empty file or missing). Existing state always wins — this never overwrites a change
   * made through the Admin UI. */
  seedFromEnv(figmaToken: string, apiKeyHashes: ReadonlyMap<string, string>): void {
    if (this.state.figmaToken || this.state.users.length > 0) return;
    let changed = false;
    if (figmaToken) {
      this.state.figmaToken = figmaToken;
      changed = true;
    }
    if (apiKeyHashes.size > 0) {
      this.state.users = [...apiKeyHashes].map(([name, hash]) => ({ name, hash }));
      changed = true;
    }
    if (changed) this.save();
  }

  getFigmaToken(): string {
    return this.state.figmaToken;
  }

  setFigmaToken(token: string): void {
    this.state.figmaToken = token;
    this.save();
  }

  getApiKeyHashes(): ReadonlyMap<string, string> {
    return new Map(this.state.users.map((user) => [user.name, user.hash]));
  }

  listUsers(): readonly { name: string }[] {
    return this.state.users.map((user) => ({ name: user.name }));
  }

  addUser(name: string): AddedUser {
    if (this.state.users.some((user) => user.name === name)) {
      this.state.users = this.state.users.filter((user) => user.name !== name);
    }
    const { key, hash } = generateApiKey(name);
    this.state.users.push({ name, hash });
    this.save();
    return { key, name };
  }

  removeUser(name: string): boolean {
    const before = this.state.users.length;
    this.state.users = this.state.users.filter((user) => user.name !== name);
    if (this.state.users.length === before) return false;
    this.save();
    return true;
  }

  hasAdmin(): boolean {
    return this.state.admin !== null;
  }

  /** Only succeeds once — call `hasAdmin()` first to guard against re-setup. */
  setupAdmin(username: string, password: string): void {
    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
    this.state.admin = { username, passwordHash, salt };
    this.save();
  }

  verifyAdmin(username: string, password: string): boolean {
    const admin = this.state.admin;
    if (!admin || admin.username !== username) return false;
    const candidate = scryptSync(password, admin.salt, SCRYPT_KEY_LENGTH);
    const expected = Buffer.from(admin.passwordHash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private load(): StoredState {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<StoredState>;
      return {
        figmaToken: raw.figmaToken ?? '',
        users: raw.users ?? [],
        admin: raw.admin ?? null,
      };
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const partialPath = `${this.filePath}.part`;
    writeFileSync(partialPath, JSON.stringify(this.state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(partialPath, this.filePath);
  }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '../domain/errors.js';

export interface Principal {
  /** Human-readable owner of the key (from configuration); used in logs and per-user limits. */
  readonly name: string;
}

export const API_KEY_PREFIX = 'fmcp_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Creates a new random API key and the configuration line that authorises it. */
export function generateApiKey(name: string): { key: string; hash: string; configEntry: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const hash = hashApiKey(key);
  return { key, hash, configEntry: `${name}=${hash}` };
}

/**
 * Parses `MCP_API_KEYS`: comma-separated `name=<sha256 hex of the key>` pairs.
 * Only hashes live in configuration, so a leaked env dump does not reveal usable keys.
 */
export function parseApiKeyConfig(raw: string): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator).trim();
    const hash = entry.slice(separator + 1).trim().toLowerCase();
    if (separator < 1 || !/^[a-z0-9._-]+$/i.test(name) || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new ConfigError(
        'MCP_API_KEYS entries must look like "name=<64-char sha256 hex>"; generate one with "npm run key:generate -- <name>".',
      );
    }
    hashes.set(name, hash);
  }
  if (hashes.size === 0) {
    throw new ConfigError('MCP_API_KEYS must contain at least one key.');
  }
  return hashes;
}

export class ApiKeyAuthenticator {
  /** Called fresh on every request, so a key added/revoked through the Admin UI applies immediately. */
  constructor(private readonly hashesByName: () => ReadonlyMap<string, string>) {}

  /** Returns the principal owning `bearerToken`, or undefined. Compares in constant time. */
  authenticate(bearerToken: string): Principal | undefined {
    const presented = Buffer.from(hashApiKey(bearerToken), 'hex');
    let match: Principal | undefined;
    // Check every key even after a match so timing does not reveal which entry matched.
    for (const [name, hash] of this.hashesByName()) {
      const candidate = Buffer.from(hash, 'hex');
      if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) {
        match = { name };
      }
    }
    return match;
  }
}

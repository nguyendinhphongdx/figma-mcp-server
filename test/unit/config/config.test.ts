import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/config.js';
import { ConfigError } from '../../../src/core/domain/errors.js';
import { hashApiKey } from '../../../src/core/security/api-keys.js';

const valid = {
  PUBLIC_BASE_URL: 'https://figma-mcp.example.com/',
  FIGMA_TOKEN: 'figd_0123456789abcdef',
  MCP_API_KEYS: `alice=${hashApiKey('k')}`,
  DOWNLOAD_SIGNING_SECRET: 's'.repeat(32),
};

const minimal = {
  PUBLIC_BASE_URL: 'https://figma-mcp.example.com/',
  DOWNLOAD_SIGNING_SECRET: 's'.repeat(32),
};

function messageOf(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(valid);
    expect(config.server).toMatchObject({ host: '0.0.0.0', port: 3000, allowedOrigins: [] });
    expect(config.figma.apiBaseUrl).toBe('https://api.figma.com');
    expect(config.figma.requestsPerMinute).toEqual({ 1: 10, 2: 25, 3: 50 });
    expect(config.figma.allowedFileKeys).toEqual([]);
    expect(config.export).toMatchObject({ maxNodes: 300, batchSize: 100, retentionHours: 24, allowInsecureImageUrls: false });
    expect(config.export.imageHostAllowlist).toEqual(['amazonaws.com', 'figma.com']);
    expect(config.downloads.urlTtlSeconds).toBe(3600);
    expect(config.figma.maxQueueWaitMs).toBe(20_000);
  });

  it('strips trailing slashes from URLs so links join cleanly', () => {
    const config = loadConfig({ ...valid, FIGMA_API_BASE_URL: 'https://proxy.example.com/figma//' });
    expect(config.server.publicBaseUrl).toBe('https://figma-mcp.example.com');
    expect(config.figma.apiBaseUrl).toBe('https://proxy.example.com/figma');
  });

  it('parses lists, numbers, flags and seconds-to-milliseconds conversions', () => {
    const config = loadConfig({
      ...valid,
      PORT: '8080',
      ALLOWED_ORIGINS: 'https://a.example, https://b.example ,',
      FIGMA_ALLOWED_FILE_KEYS: 'KEY0000001,KEY0000002',
      FIGMA_TIER1_RPM: '20',
      IMAGE_HOST_ALLOWLIST: 'cdn.example.com',
      ALLOW_INSECURE_IMAGE_URLS: 'true',
      CACHE_TTL_STRUCTURE_SECONDS: '30',
    });
    expect(config.server.port).toBe(8080);
    expect(config.server.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(config.figma.allowedFileKeys).toEqual(['KEY0000001', 'KEY0000002']);
    expect(config.figma.requestsPerMinute[1]).toBe(20);
    expect(config.export.imageHostAllowlist).toEqual(['cdn.example.com']);
    expect(config.export.allowInsecureImageUrls).toBe(true);
    expect(config.storage.ttls.structureMs).toBe(30_000);
  });

  it('expires cached image URLs before Figma does (30 days)', () => {
    expect(loadConfig(valid).storage.ttls.imageUrlMs).toBe(29 * 24 * 60 * 60 * 1000);
  });

  it('reports every problem at once and names the variable', () => {
    const message = messageOf({});
    for (const name of ['PUBLIC_BASE_URL', 'DOWNLOAD_SIGNING_SECRET']) {
      expect(message).toContain(name);
    }
  });

  it('starts up with no Figma token or users configured yet (Admin UI first-run setup)', () => {
    const config = loadConfig(minimal);
    expect(config.figma.token).toBe('');
    expect(config.auth.apiKeyHashes.size).toBe(0);
  });

  it.each([
    ['weak signing secret', { DOWNLOAD_SIGNING_SECRET: 'short' }, /DOWNLOAD_SIGNING_SECRET/],
    ['bad public URL', { PUBLIC_BASE_URL: 'not-a-url' }, /PUBLIC_BASE_URL/],
    ['tiny token', { FIGMA_TOKEN: 'x' }, /FIGMA_TOKEN/],
    ['non-numeric port', { PORT: 'abc' }, /PORT/],
    ['port out of range', { PORT: '70000' }, /PORT/],
    ['zero rate limit', { FIGMA_TIER1_RPM: '0' }, /FIGMA_TIER1_RPM/],
    ['boolean flag typo', { ALLOW_INSECURE_IMAGE_URLS: 'yes' }, /ALLOW_INSECURE_IMAGE_URLS/],
    ['unknown log level', { LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
  ])('rejects %s', (_label, override, pattern) => {
    expect(messageOf({ ...valid, ...override })).toMatch(pattern);
  });

  it('rejects API keys supplied in plain text instead of as hashes', () => {
    expect(() => loadConfig({ ...valid, MCP_API_KEYS: 'alice=fmcp_plain_key' })).toThrow(ConfigError);
  });

  it('never echoes secrets in error messages', () => {
    const message = messageOf({ ...valid, DOWNLOAD_SIGNING_SECRET: 'short-but-secret' });
    expect(message).not.toContain('short-but-secret');
  });
});

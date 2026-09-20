import { describe, expect, it } from 'vitest';
import { ConfigError, DownloadError, ForbiddenFileError } from '../../../src/core/domain/errors.js';
import {
  ApiKeyAuthenticator,
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  parseApiKeyConfig,
} from '../../../src/core/security/api-keys.js';
import { FileAccessPolicy } from '../../../src/core/security/file-access-policy.js';
import { ImageUrlPolicy } from '../../../src/core/security/image-url-policy.js';
import { UrlSigner } from '../../../src/core/security/url-signer.js';

describe('UrlSigner', () => {
  const NOW = 1_700_000_000;
  const signer = new UrlSigner('a-long-enough-secret-for-tests-1234', () => NOW);

  it('verifies a signature it issued', () => {
    const { expiresAt, signature } = signer.sign('exp1/a.jpg', 3600);
    expect(expiresAt).toBe(NOW + 3600);
    expect(signer.verify('exp1/a.jpg', expiresAt, signature)).toBe(true);
  });

  it('rejects a signature for another resource', () => {
    const { expiresAt, signature } = signer.sign('exp1/a.jpg', 3600);
    expect(signer.verify('exp1/b.jpg', expiresAt, signature)).toBe(false);
  });

  it('rejects a tampered expiry (cannot extend a link)', () => {
    const { expiresAt, signature } = signer.sign('exp1/a.jpg', 3600);
    expect(signer.verify('exp1/a.jpg', expiresAt + 1, signature)).toBe(false);
  });

  it('rejects an expired link, but accepts one expiring right now', () => {
    const { expiresAt, signature } = signer.sign('r', 10);
    expect(new UrlSigner('a-long-enough-secret-for-tests-1234', () => expiresAt).verify('r', expiresAt, signature)).toBe(true);
    expect(new UrlSigner('a-long-enough-secret-for-tests-1234', () => expiresAt + 1).verify('r', expiresAt, signature)).toBe(false);
  });

  it('rejects signatures made with another secret, wrong lengths, and junk expiries', () => {
    const other = new UrlSigner('another-secret-another-secret-12345', () => NOW).sign('r', 60);
    expect(signer.verify('r', other.expiresAt, other.signature)).toBe(false);

    const { expiresAt, signature } = signer.sign('r', 60);
    expect(signer.verify('r', expiresAt, signature.slice(1))).toBe(false);
    expect(signer.verify('r', expiresAt, '')).toBe(false);
    expect(signer.verify('r', Number.NaN, signature)).toBe(false);
    expect(signer.verify('r', expiresAt + 0.5, signature)).toBe(false);
  });

  it('is not fooled by a resource that embeds the expiry separator', () => {
    const a = signer.sign('x\n1', 60);
    expect(signer.verify('x', a.expiresAt, a.signature)).toBe(false);
  });
});

describe('API keys', () => {
  it('generates prefixed, unique keys whose hash matches the config entry', () => {
    const one = generateApiKey('alice');
    const two = generateApiKey('alice');
    expect(one.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(one.key).not.toBe(two.key);
    expect(one.hash).toBe(hashApiKey(one.key));
    expect(one.configEntry).toBe(`alice=${one.hash}`);
    expect(one.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses a comma-separated list, trims, and lower-cases hashes', () => {
    const a = hashApiKey('a');
    const b = hashApiKey('b');
    const parsed = parseApiKeyConfig(` alice=${a.toUpperCase()} , bob.smith=${b},`);
    expect([...parsed]).toEqual([
      ['alice', a],
      ['bob.smith', b],
    ]);
  });

  it.each([
    ['empty', ''],
    ['only separators', ' , ,'],
    ['no separator', 'alice'],
    ['no name', `=${'a'.repeat(64)}`],
    ['short hash', 'alice=abc123'],
    ['non-hex hash', `alice=${'z'.repeat(64)}`],
    ['bad name characters', `al ice=${'a'.repeat(64)}`],
    ['plain key instead of hash', 'alice=fmcp_secret'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseApiKeyConfig(raw)).toThrow(ConfigError);
  });

  it('authenticates the right principal and nobody else', () => {
    const hashes = parseApiKeyConfig(`alice=${hashApiKey('key-a')},bob=${hashApiKey('key-b')}`);
    const auth = new ApiKeyAuthenticator(() => hashes);
    expect(auth.authenticate('key-a')).toEqual({ name: 'alice' });
    expect(auth.authenticate('key-b')).toEqual({ name: 'bob' });
    expect(auth.authenticate('key-c')).toBeUndefined();
    expect(auth.authenticate('')).toBeUndefined();
  });

  it('a stored hash is not itself a valid credential', () => {
    const hash = hashApiKey('key-a');
    const auth = new ApiKeyAuthenticator(() => parseApiKeyConfig(`alice=${hash}`));
    expect(auth.authenticate(hash)).toBeUndefined();
  });

  it('picks up a hash map change on the very next call (hot reload)', () => {
    let hashes = parseApiKeyConfig(`alice=${hashApiKey('key-a')}`);
    const auth = new ApiKeyAuthenticator(() => hashes);
    expect(auth.authenticate('key-b')).toBeUndefined();
    hashes = parseApiKeyConfig(`alice=${hashApiKey('key-a')},bob=${hashApiKey('key-b')}`);
    expect(auth.authenticate('key-b')).toEqual({ name: 'bob' });
  });
});

describe('FileAccessPolicy', () => {
  it('allows everything when the list is empty', () => {
    const policy = new FileAccessPolicy([]);
    expect(policy.restricted).toBe(false);
    expect(() => policy.assertAllowed('ANYTHING123')).not.toThrow();
  });

  it('allows only listed files otherwise, with a message that says how to fix it', () => {
    const policy = new FileAccessPolicy(['ALLOWED0001']);
    expect(policy.restricted).toBe(true);
    expect(() => policy.assertAllowed('ALLOWED0001')).not.toThrow();
    expect(() => policy.assertAllowed('OTHER000001')).toThrow(ForbiddenFileError);
    expect(() => policy.assertAllowed('OTHER000001')).toThrow(/FIGMA_ALLOWED_FILE_KEYS/);
  });
});

describe('ImageUrlPolicy (SSRF guard)', () => {
  const policy = new ImageUrlPolicy({ allowedHostSuffixes: ['amazonaws.com', 'figma.com'], allowInsecure: false });

  it.each([
    'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc',
    'https://amazonaws.com/x',
    'https://www.figma.com/img.png',
  ])('accepts %s', (url) => {
    expect(policy.assertAllowed(url).href).toBe(new URL(url).href);
  });

  it.each([
    ['plain http', 'http://s3.amazonaws.com/x'],
    ['unlisted host', 'https://evil.example/x'],
    ['look-alike suffix', 'https://notamazonaws.com/x'],
    ['allowed name as a subdomain of another host', 'https://amazonaws.com.evil.example/x'],
    ['cloud metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['localhost', 'https://localhost/x'],
    ['embedded credentials', 'https://user:pass@s3.amazonaws.com/x'],
    ['other scheme', 'file:///etc/passwd'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(() => policy.assertAllowed(url)).toThrow(DownloadError);
  });

  it('allows http only when explicitly opted in (tests)', () => {
    const lenient = new ImageUrlPolicy({ allowedHostSuffixes: ['127.0.0.1'], allowInsecure: true });
    expect(() => lenient.assertAllowed('http://127.0.0.1:9/x')).not.toThrow();
    expect(() => lenient.assertAllowed('http://evil.example/x')).toThrow(DownloadError);
  });
});

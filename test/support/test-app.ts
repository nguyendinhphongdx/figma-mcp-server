import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App, type AppOverrides } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import { hashApiKey } from '../../src/core/security/api-keys.js';
import { silentLogger } from '../../src/infra/logger.js';
import { FIGMA_TOKEN, type FakeFigma } from './fake-figma.js';

export const TEST_API_KEY = 'fmcp_test-key-for-alice';
export const SIGNING_SECRET = 'test-signing-secret-that-is-long-enough-123';

export interface TestApp {
  readonly app: App;
  readonly config: AppConfig;
  readonly baseUrl: string;
  readonly dataDir: string;
  /** MCP client authenticated as `alice`. */
  connect(apiKey?: string): Promise<Client>;
  /** Calls a tool and parses its JSON payload. */
  call(client: Client, name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any }>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface StartOptions {
  readonly env?: Record<string, string>;
  readonly overrides?: AppOverrides;
}

export async function startTestApp(figma: FakeFigma, options: StartOptions = {}): Promise<TestApp> {
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'figma-mcp-test-'));
  const baseUrl = `http://127.0.0.1:${port}`;

  const config = loadConfig({
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    FIGMA_TOKEN,
    FIGMA_API_BASE_URL: figma.baseUrl,
    // Generous budgets so pacing never slows the tests; the governor has its own unit tests.
    FIGMA_TIER1_RPM: '6000',
    FIGMA_TIER2_RPM: '6000',
    FIGMA_TIER3_RPM: '6000',
    MCP_API_KEYS: `alice=${hashApiKey(TEST_API_KEY)},bob=${hashApiKey('fmcp_test-key-for-bob')}`,
    DOWNLOAD_SIGNING_SECRET: SIGNING_SECRET,
    DATA_DIR: dataDir,
    IMAGE_HOST_ALLOWLIST: '127.0.0.1',
    ALLOW_INSECURE_IMAGE_URLS: 'true',
    LOG_LEVEL: 'silent',
    ...options.env,
  });

  const app = buildApp(config, silentLogger, options.overrides);
  await app.listen();

  const clients: Client[] = [];
  return {
    app,
    config,
    baseUrl,
    dataDir,
    async connect(apiKey = TEST_API_KEY) {
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async call(client, name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? 'null';
      return { isError: result.isError === true, data: JSON.parse(text) };
    },
    async stop() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

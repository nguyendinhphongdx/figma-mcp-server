#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateApiKey } from './core/security/api-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FMCP_DIR = path.join(os.homedir(), '.fmcp');
const PID_FILE = path.join(FMCP_DIR, 'fmcp.pid');
const LOG_FILE = path.join(FMCP_DIR, 'fmcp.log');
const ENV_FILE = path.join(FMCP_DIR, '.env');
const DATA_DIR_DEFAULT = path.join(FMCP_DIR, 'data');
const MAIN_ENTRY = path.join(__dirname, 'main.js');

if (!fs.existsSync(FMCP_DIR)) {
  fs.mkdirSync(FMCP_DIR, { recursive: true });
}

const command = process.argv[2];
const args = process.argv.slice(3);

interface CommandInfo {
  description: string;
  handler: () => void;
}

const commands: Record<string, CommandInfo> = {
  init: { description: 'Create ~/.fmcp/.env from the example template', handler: cmdInit },
  key: { description: 'Generate an API key for a user and add it to config', handler: cmdKey },
  start: { description: 'Start the server in background', handler: cmdStart },
  stop: { description: 'Stop the running server', handler: cmdStop },
  restart: { description: 'Restart the server', handler: cmdRestart },
  status: { description: 'Show server status', handler: cmdStatus },
  logs: { description: 'Show server logs (-f to follow)', handler: cmdLogs },
  run: { description: 'Run server in foreground (debug)', handler: cmdRun },
  help: { description: 'Show this help message', handler: cmdHelp },
};

if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
  console.log(pkg.version);
} else if (!command || command === 'help' || command === '--help' || command === '-h') {
  cmdHelp();
} else if (commands[command]) {
  commands[command].handler();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "fmcp help" for available commands.');
  process.exit(1);
}

// ===== Commands =====

function cmdInit(): void {
  if (fs.existsSync(ENV_FILE)) {
    console.log(`${ENV_FILE} already exists.`);
    return;
  }
  const examplePath = path.resolve(__dirname, '../.env.example');
  const example = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf-8') : '';
  // Auto-generate the one required secret that has no reasonable default, so "init && start"
  // is enough to boot — the Figma token, admin account and users are all set up in the browser.
  const secret = randomBytes(48).toString('base64url');
  const withSecret = example.replace(/^DOWNLOAD_SIGNING_SECRET=.*$/m, `DOWNLOAD_SIGNING_SECRET=${secret}`);
  fs.writeFileSync(ENV_FILE, withSecret, 'utf-8');
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {
    /* Windows ignores POSIX permissions */
  }
  console.log(`Created ${ENV_FILE}.`);
  console.log('Run "fmcp start", then open the Admin UI to set your Figma token and add users.');
}

function cmdKey(): void {
  const name = args[0];
  if (!name || !/^[a-z0-9._-]+$/i.test(name)) {
    console.error('Usage: fmcp key <user-name>   (letters, digits, . _ -)');
    process.exit(2);
  }
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`No config found at ${ENV_FILE}. Run "fmcp init" first.`);
    process.exit(1);
  }

  const { key, configEntry } = generateApiKey(name);
  appendApiKeyEntry(configEntry);

  console.log(`API key for ${name} (give this to the user; it cannot be recovered later):`);
  console.log(`  ${key}`);
  console.log('');
  console.log(`Added to ${ENV_FILE}: ${configEntry}`);
  console.log(isRunning() ? 'Restart the server to apply it: fmcp restart' : 'Now run: fmcp start');
}

/** Rewrites the (uncommented) `MCP_API_KEYS=` line in the config file, appending
 * `entry` to whatever is already there, or adds the line if none exists yet. */
function appendApiKeyEntry(entry: string): void {
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  const lineRegex = /^MCP_API_KEYS=(.*)$/m;
  let updated: string;
  if (lineRegex.test(content)) {
    updated = content.replace(lineRegex, (_match, existing: string) => {
      const trimmed = existing.trim();
      return `MCP_API_KEYS=${trimmed ? `${trimmed},${entry}` : entry}`;
    });
  } else {
    const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    updated = `${content}${separator}MCP_API_KEYS=${entry}\n`;
  }
  fs.writeFileSync(ENV_FILE, updated, 'utf-8');
}

function cmdStart(): void {
  if (isRunning()) {
    console.log(`Server is already running (PID: ${readPid()}).`);
    return;
  }
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`No config found at ${ENV_FILE}. Run "fmcp init" first, then edit it.`);
    process.exit(1);
  }

  console.log('Starting figma-mcp-server...');

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [MAIN_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv(),
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  setTimeout(() => {
    if (!isRunning()) {
      console.error('Server failed to start. Last log lines:');
      try {
        const log = fs.readFileSync(LOG_FILE, 'utf-8');
        log.trim().split('\n').slice(-10).forEach((line) => console.error('  ' + line));
      } catch {
        /* no log yet */
      }
      cleanPid();
      process.exit(1);
    } else {
      console.log(`Server started (PID: ${child.pid}).`);
      console.log(`Admin UI: ${childEnv().PUBLIC_BASE_URL ?? 'http://localhost:3000'}/`);
      console.log('Logs: fmcp logs -f');
    }
  }, 1500);
}

function cmdStop(): void {
  const pid = readPid();
  if (!pid || !isRunning()) {
    console.log('Server is not running.');
    cleanPid();
    return;
  }
  console.log(`Stopping server (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    console.log('Server stopped.');
  } catch {
    console.log('Process not found, cleaning up.');
  }
  cleanPid();
}

function cmdRestart(): void {
  cmdStop();
  setTimeout(() => cmdStart(), 500);
}

function cmdStatus(): void {
  if (isRunning()) {
    console.log(`Server is running (PID: ${readPid()}).`);
  } else {
    console.log('Server is not running.');
    cleanPid();
  }
}

function cmdLogs(): void {
  const countArg = args.find((a) => a !== '-f' && a !== '--follow');
  const lines = countArg ? parseInt(countArg, 10) : 50;

  if (!fs.existsSync(LOG_FILE)) {
    console.log('No log file found.');
    return;
  }

  if (args.includes('-f') || args.includes('--follow')) {
    followLogFile(lines);
    return;
  }

  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  console.log(content.split('\n').slice(-lines).join('\n'));
}

/** Polls file size instead of shelling out to `tail -f` (no such binary on
 * Windows) and re-reads from 0 if the file shrinks, so it keeps following
 * across a restart that truncates or replaces the log file. */
function followLogFile(initialLines: number): void {
  const initialContent = fs.readFileSync(LOG_FILE, 'utf-8');
  const tail = initialContent.split('\n').slice(-initialLines).join('\n');
  if (tail) process.stdout.write(tail + '\n');

  let position = fs.statSync(LOG_FILE).size;
  const interval = setInterval(() => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(LOG_FILE);
    } catch {
      return;
    }
    if (stat.size < position) position = 0;
    if (stat.size <= position) return;

    const fd = fs.openSync(LOG_FILE, 'r');
    const buffer = Buffer.alloc(stat.size - position);
    fs.readSync(fd, buffer, 0, buffer.length, position);
    fs.closeSync(fd);
    position = stat.size;
    process.stdout.write(buffer.toString('utf-8'));
  }, 2000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });
}

function cmdRun(): void {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`No config found at ${ENV_FILE}. Run "fmcp init" first, then edit it.`);
    process.exit(1);
  }
  console.log('Running figma-mcp-server in foreground (Ctrl+C to stop)...');
  const child = spawn(process.execPath, [MAIN_ENTRY], { stdio: 'inherit', env: childEnv() });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdHelp(): void {
  console.log('');
  console.log('  figma-mcp-server CLI');
  console.log('');
  console.log('  Usage: fmcp <command> [options]');
  console.log('');
  console.log('  Commands:');
  const maxLen = Math.max(...Object.keys(commands).map((k) => k.length));
  for (const [name, info] of Object.entries(commands)) {
    console.log(`    ${name.padEnd(maxLen + 2)} ${info.description}`);
  }
  console.log('');
  console.log('  Examples:');
  console.log('    fmcp init          Create ~/.fmcp/.env to fill in');
  console.log('    fmcp key alice     Generate a key for a user, add it to config');
  console.log('    fmcp start         Start in background');
  console.log('    fmcp status        Check if it is running');
  console.log('    fmcp logs -f       Follow log output');
  console.log('    fmcp stop          Stop it');
  console.log('');
  console.log(`  Config file: ${ENV_FILE}`);
  console.log(`  Data dir   : ${DATA_DIR_DEFAULT} (unless DATA_DIR is set in the config file)`);
  console.log('');
}

// ===== Helpers =====

function readPid(): number | null {
  try {
    return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function cleanPid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

function isRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parses `KEY=VALUE` lines from ~/.fmcp/.env, ignoring blank lines and `#` comments. */
function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** Builds the child process environment: DATA_DIR defaults under ~/.fmcp,
 * then the config file's values take priority, matching how the project's
 * own `.env` is expected to override defaults. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATA_DIR: DATA_DIR_DEFAULT,
    ...readEnvFile(),
  };
}

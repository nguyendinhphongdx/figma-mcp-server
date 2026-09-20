import { generateApiKey } from '../src/core/security/api-keys.js';

const name = process.argv[2];
if (!name || !/^[a-z0-9._-]+$/i.test(name)) {
  console.error('Usage: npm run key:generate -- <user-name>   (letters, digits, . _ -)');
  process.exit(2);
}

const { key, configEntry } = generateApiKey(name);

console.log(`API key for ${name} (give this to the user; it cannot be recovered later):`);
console.log(`  ${key}`);
console.log('');
console.log('Add this entry to MCP_API_KEYS (comma-separated for several users):');
console.log(`  ${configEntry}`);

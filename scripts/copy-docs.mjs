// Post-build step: `tsc` mirrors `src/` into `dist/` but only compiles `.ts`, so the Admin UI's
// doc pages (plain `.md` files under `src/adapters/http/docs/`) need copying by hand.
import { chmodSync, cpSync } from 'node:fs';

cpSync('src/adapters/http/docs', 'dist/adapters/http/docs', { recursive: true });

try {
  chmodSync('dist/cli.js', 0o755);
} catch {
  // No exec bit on Windows; nothing to do.
}

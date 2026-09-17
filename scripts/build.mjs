import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/yet.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: true,
  packages: 'external',
  loader: { '.wav': 'base64', '.md': 'text' },
  outfile: 'dist/yet.js',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});

await copyFile('src/sounds/assets/LICENSE.txt', 'dist/CUELUME-LICENSE.txt');
await copyFile('src/config/prompts/LICENSE.txt', 'dist/CODEX-LICENSE.txt');
await copyFile('src/config/prompts/NOTICE.txt', 'dist/CODEX-NOTICE.txt');

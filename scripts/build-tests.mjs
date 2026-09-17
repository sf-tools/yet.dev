import { build } from 'esbuild';

await build({
  entryPoints: ['tests/run.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  loader: { '.wav': 'base64' },
  outfile: '.yet-build/tests.js',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});

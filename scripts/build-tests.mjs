import { build } from 'esbuild';

await build({
  entryPoints: { tests: 'tests/run.ts', 'providers-tests': 'tests/providers.test.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  loader: { '.wav': 'base64' },
  outdir: '.yet-build',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});

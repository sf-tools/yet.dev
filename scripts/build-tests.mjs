import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: { tests: 'tests/run.ts', 'providers-tests': 'tests/providers.test.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  loader: { '.wav': 'base64', '.md': 'text' },
  outdir: '.yet-build',
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});

await build({
  entryPoints: { 'streaming-tests': 'tests/streaming.test.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  loader: { '.wav': 'base64', '.md': 'text' },
  outdir: '.yet-build',
  tsconfig: 'tsconfig.json',
  plugins: [{
    name: 'scripted-agent-loop',
    setup(build) {
      build.onResolve({ filter: /^\.\/runner$/ }, args =>
        /src\/agent\/(app|runtime)\.ts$/.test(args.importer)
          ? { path: resolve('tests/fixtures/agent-loop.ts') }
          : undefined);
    },
  }],
  logLevel: 'info',
});

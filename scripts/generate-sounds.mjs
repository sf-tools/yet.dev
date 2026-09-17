// Run with Node 22+: node scripts/generate-sounds.mjs
// Cuelume's browser synth is rendered offline; playback needs no npm audio dependency.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dependencyDir = resolve('.yet-build/cuelume-render');
await mkdir(dependencyDir, { recursive: true });
execFileSync('npm', ['install', '--prefix', dependencyDir, '--no-audit', '--no-fund',
  '--package-lock=false', 'cuelume@0.2.2', 'node-web-audio-api@2.2.0'], { stdio: 'inherit' });
const require = createRequire(pathToFileURL(`${dependencyDir}/render.cjs`));
const { OfflineAudioContext } = await import(pathToFileURL(require.resolve('node-web-audio-api')).href);
const cuelumeEntry = pathToFileURL(`${dependencyDir}/node_modules/cuelume/dist/index.js`);
const outputDir = resolve('src/sounds/assets');
await mkdir(outputDir, { recursive: true });

for (const name of ['bloom', 'success', 'error', 'scan']) {
  const sampleRate = 44100;
  const context = new OfflineAudioContext(1, sampleRate * 3, sampleRate);
  // Schedule Cuelume synchronously before starting the offline render.
  Object.defineProperty(context, 'state', { get: () => 'running' });
  globalThis.window = { AudioContext: class { constructor() { return context; } } };
  const engineURL = new URL(`./audio/engine.js?cue=${name}`, cuelumeEntry);
  const { play } = await import(engineURL.href);
  play(name);
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  let end = samples.length;
  while (end > 0 && Math.abs(samples[end - 1]) < 0.00001) end -= 1;
  if (end === 0) throw new Error(`Cuelume rendered silence for ${name}`);
  const length = Math.min(samples.length, end + Math.round(sampleRate * 0.08));
  const wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(length * 2, 40);
  for (let index = 0; index < length; index += 1) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), 44 + index * 2);
  }
  await writeFile(`${outputDir}/${name}.wav`, wav);
  console.log(`${name}: ${(length / sampleRate).toFixed(2)}s`);
}
await writeFile(`${outputDir}/LICENSE.txt`, await readFile(new URL('../LICENSE', cuelumeEntry)));

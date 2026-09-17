// Usage: node scripts/sync-codex-prompts.mjs /path/to/openai/codex (Node 22.18+).
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readCodexInstructions } from '../src/config/model-instructions.ts';

if (!process.argv[2]) throw new Error('Pass the path to an OpenAI Codex checkout.');
const source = resolve(process.argv[2]);
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const catalog = JSON.parse(await readFile(join(source, 'codex-rs/models-manager/models.json'), 'utf8'));
const destination = resolve('src/config/prompts');
await mkdir(destination, { recursive: true });
for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
  const instructions = readCodexInstructions(catalog.models.find(entry => entry.slug === model));
  if (!instructions) throw new Error(`Missing Codex instructions for ${model}`);
  await writeFile(join(destination, `${model}.md`), `${instructions}\n`);
}
await copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE.txt'));
await writeFile(join(destination, 'NOTICE.txt'), `OpenAI Codex\nCopyright 2025 OpenAI\n\nInstruction templates derived from openai/codex, revision ${revision}.\nModified for Yet's identity, available tools, and skill handling.\n`);

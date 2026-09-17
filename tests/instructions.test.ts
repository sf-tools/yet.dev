import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions, PROJECT_INSTRUCTIONS_MAX_BYTES } from '@/agent/project-instructions';
import { prepareAgentMessages } from '@/agent/instructions';
import { createSystemPrompt, createInitialMessages } from '@/config/prompt';
import { adaptCodexInstructions, readCodexInstructions } from '@/config/model-instructions';
import { ROOT_AGENT_INSTRUCTIONS, subagentInstructions } from '@/agent/collaboration/role-instructions';
import { setOpenAIModelCatalog } from '@/config/models';
import type { AgentMessage } from '@/agent/messages';
import { check, deepEqual, equal } from './harness';

const directory = await mkdtemp(join(tmpdir(), 'yet-instructions-'));
const yetHome = join(directory, 'home');
const root = join(directory, 'repo');
const child = join(root, 'packages', 'app');
try {
  await mkdir(yetHome);
  await mkdir(child, { recursive: true });
  await mkdir(join(root, '.git'));
  await writeFile(join(directory, 'AGENTS.md'), 'Outside the repository.');
  await writeFile(join(yetHome, 'AGENTS.md'), 'Global instructions.');
  await writeFile(join(root, 'AGENTS.md'), 'Root instructions.');
  await writeFile(join(root, 'packages', 'AGENTS.md'), 'Package instructions.');
  await writeFile(join(child, 'AGENTS.md'), 'Overridden child instructions.');
  await writeFile(join(child, 'AGENTS.override.md'), 'Child override instructions.');
  const options = { cwd: child, yetHome };
  const loaded = await loadProjectInstructions(options);
  // macOS resolves /var to /private/var, so compare the relative suffixes.
  deepEqual(loaded.files.map(file => file.slice(file.indexOf(directory.split('/').at(-1)!))), [
    join(yetHome, 'AGENTS.md'), join(root, 'AGENTS.md'), join(root, 'packages', 'AGENTS.md'), join(child, 'AGENTS.override.md'),
  ].map(file => file.slice(file.indexOf(directory.split('/').at(-1)!))), 'instructions load global scope then repository ancestors in order');
  check(!loaded.text.includes('Outside the repository.') && !loaded.text.includes('Overridden child'), 'project boundaries and per-directory overrides are respected');
  check(!loaded.truncated, 'small instruction sets fit the default limit');

  await writeFile(join(yetHome, 'AGENTS.override.md'), 'Global override.');
  await writeFile(join(child, 'AGENTS.override.md'), ' \n\t');
  const overridden = await loadProjectInstructions(options);
  check(overridden.text.includes('Global override.') && !overridden.text.includes('Global instructions.'), 'global overrides take precedence');
  check(overridden.text.includes('Overridden child instructions.'), 'empty overrides fall back to AGENTS.md');

  const nonRepo = join(directory, 'plain', 'child');
  await mkdir(nonRepo, { recursive: true });
  await writeFile(join(directory, 'plain', 'AGENTS.md'), 'Parent without a repository.');
  await writeFile(join(nonRepo, 'AGENTS.md'), 'Standalone directory.');
  const standalone = await loadProjectInstructions({ cwd: nonRepo, yetHome });
  check(standalone.text.includes('Standalone directory.') && !standalone.text.includes('Parent without a repository.'), 'outside repositories only the current directory contributes project instructions');

  await rm(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git'), 'gitdir: /example/worktree\n');
  check((await loadProjectInstructions(options)).text.includes('Root instructions.'), 'worktree .git pointer files define repository roots');
  const emptyHome = join(directory, 'empty-home');
  await mkdir(emptyHome);
  await writeFile(join(nonRepo, 'AGENTS.md'), '😀'.repeat(20_000));
  const bounded = await loadProjectInstructions({ cwd: nonRepo, yetHome: emptyHome, maxBytes: 7 });
  check(bounded.truncated && bounded.text.includes('😀') && !bounded.text.includes('�'), 'instruction truncation preserves UTF-8 character boundaries');
  const defaultBounded = await loadProjectInstructions({ cwd: nonRepo, yetHome: emptyHome });
  check(defaultBounded.truncated && defaultBounded.text.includes(String(PROJECT_INSTRUCTIONS_MAX_BYTES)), 'oversized instructions report the 32 KiB limit');
  equal((await loadProjectInstructions({ ...options, maxBytes: 0 })).text, '', 'a zero instruction budget loads no files');

  const sol = createSystemPrompt('gpt-5.6-sol', child);
  const astra = createSystemPrompt('gpt-6-astra', child);
  check(sol !== astra, 'bundled instruction templates vary by model');
  equal(createSystemPrompt('gpt-5.6-terra', child), sol, 'Terra uses the shared upstream GPT-5.6 template');
  check(sol.includes('## File editing constraints') && astra.includes('### Writing PR descriptions'), 'bundled prompts retain Codex workflow guidance');
  check(createSystemPrompt('gpt-5.5').includes('## Engineering judgment'), 'GPT-5.5 retains its model-specific engineering instructions');
  for (const prompt of [sol, astra, createSystemPrompt('gpt-5.5'), createSystemPrompt('gpt-5.4'), createSystemPrompt('gpt-5.4-mini')]) {
    check(prompt.includes('You are Yet,') && !prompt.includes('functions.exec') && !prompt.includes('multi_tool_use.parallel') && !prompt.includes('{{ personality }}'), 'bundled templates match Yet’s identity and actual tool interface');
  }
  equal(readCodexInstructions({ model_messages: { instructions_template: '' }, base_instructions: 'Legacy instructions.' }), 'Legacy instructions.', 'empty templates fall back to legacy base instructions');
  equal(readCodexInstructions({ model_messages: { instructions_template: 123 } }), undefined, 'malformed instructions fall back to bundled templates');
  check(!adaptCodexInstructions('You are Codex.\n\n# Plugins\nImaginary plugin tool.\n\n# General\nKeep this rule.').includes('Imaginary'), 'Codex-only integration sections are removed');
  check(!ROOT_AGENT_INSTRUCTIONS.includes('functions.exec') && !subagentInstructions('/root/worker').includes('functions.exec'), 'collaboration instructions use direct tool calls');

  const oldBase = 'You are Yet, a focused coding agent made by The San Francisco Tooling Company.\nOld generic prompt.';
  const history: AgentMessage[] = [
    { role: 'system', content: oldBase },
    { role: 'system', content: 'You are /root, the primary agent in a team of agents. Use functions.exec.' },
    { role: 'user', content: 'Existing user request.' },
    { role: 'assistant', content: 'Existing response.', phase: 'final_answer' },
  ];
  const prepared = await prepareAgentMessages(history, { ...options, model: 'gpt-6-astra' });
  check(prepared[0].role === 'system' && prepared[0].content === astra, 'resumed sessions replace the legacy prompt with the current model template');
  check(!JSON.stringify(prepared).includes('functions.exec') && !JSON.stringify(prepared).includes('Old generic prompt.'), 'resumed sessions discard obsolete generated tool instructions');
  equal(history[0].role === 'system' ? history[0].content : '', oldBase, 'preparing a request does not rewrite stored history');
  const repositoryIndex = prepared.findIndex(message => 'instructionContext' in message && message.instructionContext === 'repository');
  check(repositoryIndex >= 0 && prepared[repositoryIndex].role === 'user', 'repository documents are user context rather than system instructions');
  check(repositoryIndex < prepared.findIndex(message => 'content' in message && message.content === 'Existing user request.'), 'repository guidance precedes the conversation so direct user instructions can override it');
  const switched = await prepareAgentMessages(prepared, { ...options, model: 'gpt-5.6-sol' });
  equal(switched.filter(message => 'instructionContext' in message).length, 1, 'repeated preparation does not duplicate repository instructions');
  equal(switched[0].role === 'system' ? switched[0].content : '', sol, 'model switches replace rather than accumulate base prompts');
  await writeFile(join(root, 'AGENTS.md'), 'Updated root guidance.');
  check(JSON.stringify(await prepareAgentMessages(history, { ...options, model: 'gpt-5.6-sol' })).includes('Updated root guidance.'), 'subsequent turns pick up changed repository guidance');
  const childMessages = await prepareAgentMessages([
    ...createInitialMessages(), { role: 'system', content: 'Your canonical task name is `/root/worker`. Use functions.exec.' },
  ], { ...options, model: 'gpt-5.5' });
  check(JSON.stringify(childMessages).includes('## Engineering judgment') && JSON.stringify(childMessages).includes('Updated root guidance.'), 'subagents get their own model template and workspace instructions');
  check(!JSON.stringify(childMessages).includes('functions.exec'), 'resumed subagent role instructions are refreshed');

  setOpenAIModelCatalog([{ id: 'custom-model', providerId: 'custom-model', label: 'Custom', description: '', contextWindow: null, efforts: ['auto'], instructions: 'Account-specific template.' }]);
  check(createSystemPrompt('custom-model').includes('Account-specific template.'), 'account-provided instructions take precedence over bundled fallbacks');
  setOpenAIModelCatalog(null);
  check(!createSystemPrompt('custom-model').includes('Account-specific template.'), 'resetting account metadata also resets model instructions');
} finally {
  setOpenAIModelCatalog(null);
  await rm(directory, { recursive: true, force: true });
}

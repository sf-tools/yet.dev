import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAvailableOpenAIModels, loadOpenAIModelCache, refreshOpenAIModelAccess, resetOpenAIModelAccess } from '@/auth/models';
import { saveStoredOpenAIAuth } from '@/auth/storage';
import { getOpenAIContextWindow, getOpenAIProviderModelId, getSupportedThinkingModes, normalizeYetPreferences } from '@/config';
import { handleCliArgs } from '@/cli';
import { builtinSlashCommands, createSlashCommandRegistry, type SlashCommandContext } from '@/agent/slash-commands';
import { check, deepEqual, equal, rejects } from './harness';

const directory = await mkdtemp(join(tmpdir(), 'yet-models-test-'));
const authPath = join(directory, 'auth.json');
const cacheDirectory = join(directory, 'models-cache');
const registry = createSlashCommandRegistry(builtinSlashCommands);
const suggestions = () => registry.listSuggestions({ type: 'argument', invocation: 'model', query: '' });
const ids = () => getAvailableOpenAIModels().map(model => model.id);
const astra = 'gpt-6-astra';
const daybreak = 'gpt-daybreak-blue-latest';
const newModel = 'gpt-catalog-test';
const oauth = {
  version: 1 as const, provider: 'openai' as const, method: 'oauth' as const,
  accessToken: 'oauth-model-test', refreshToken: 'refresh-model-test', idToken: 'id-model-test',
  accountId: 'model-account', expiresAt: Date.now() + 3_600_000, updatedAt: new Date().toISOString(),
};
let fetches = 0;
const catalogFetch = (async (url, init) => {
  fetches += 1;
  check(String(url).endsWith('/codex/models?client_version=0.153.0'), 'ChatGPT discovery sends the Astra-compatible catalog version');
  equal((init?.headers as Record<string, string>)['ChatGPT-Account-ID'], 'model-account', 'catalog is scoped to the selected account');
  return Response.json({ models: [
    { slug: astra, display_name: 'GPT-6-Astra', context_window: 272_000, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], base_instructions: 'large prompt must not be cached' },
    { slug: newModel, display_name: 'Catalog model', description: 'From the account', context_window: 512_000, visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
    { slug: daybreak, visibility: 'hide' },
  ] });
}) as typeof fetch;
const options = { authPath, fetch: catalogFetch };

async function expireCaches() {
  for (const name of await readdir(cacheDirectory)) {
    const path = join(cacheDirectory, name);
    const entry = JSON.parse(await readFile(path, 'utf8'));
    entry.fetchedAt = Date.now() - 6 * 60_000;
    await writeFile(path, JSON.stringify(entry));
  }
  await loadOpenAIModelCache(options);
}

try {
  resetOpenAIModelAccess();
  check(!ids().includes(astra) && !ids().includes(daybreak), 'uncached fallback hides account-gated models');
  await saveStoredOpenAIAuth(oauth, authPath);
  await loadOpenAIModelCache(options);
  equal(fetches, 0, 'cache initialization never requests the network');
  await refreshOpenAIModelAccess(options);
  deepEqual(ids(), [astra, newModel], 'remote catalog replaces the full bundled picker list');
  equal(suggestions().length, 2, 'picker uses all visible catalog models');
  equal(getOpenAIContextWindow(newModel), 512_000, 'new model context comes from the catalog');
  deepEqual(getSupportedThinkingModes(newModel), ['auto', 'medium', 'high'], 'new model reasoning levels come from the catalog');
  equal(getOpenAIProviderModelId(newModel), newModel, 'new catalog models can be sent to the provider');
  equal(normalizeYetPreferences({ model: newModel }).model, newModel, 'preferences retain catalog models');
  const cli = handleCliArgs(['--model', newModel, '--effort', 'high']);
  check(cli.kind === 'start' && cli.model === newModel, 'CLI accepts discovered model IDs');

  const files = await readdir(cacheDirectory);
  equal(files.length, 1, 'catalog is persisted in one account cache');
  const cachedText = await readFile(join(cacheDirectory, files[0]), 'utf8');
  check(!cachedText.includes('large prompt') && !cachedText.includes(oauth.accessToken), 'cache omits system prompts and credentials');
  resetOpenAIModelAccess();
  await loadOpenAIModelCache(options);
  deepEqual(ids(), [astra, newModel], 'a new process can restore the full model list from disk');
  equal(fetches, 1, 'restoring cached metadata needs no HTTP request');
  await refreshOpenAIModelAccess(options);
  equal(fetches, 1, 'fresh catalogs skip network refresh');
  await saveStoredOpenAIAuth({ ...oauth, accessToken: 'rotated-token' }, authPath);
  await loadOpenAIModelCache(options);
  deepEqual(ids(), [astra, newModel], 'OAuth token rotation retains the account cache');

  await expireCaches();
  deepEqual(ids(), [astra, newModel], 'stale cached models remain immediately available');
  let release!: (response: Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const refreshing = refreshOpenAIModelAccess({ authPath, fetch: (async () => {
    started();
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch });
  await requestStarted;
  deepEqual(ids(), [astra, newModel], 'a stalled background request does not block cached model selection');
  release(new Response('', { status: 503 }));
  await refreshing;
  deepEqual(ids(), [astra, newModel], 'transient catalog failures preserve the cached list');
  await refreshOpenAIModelAccess({ authPath, fetch: (async () => Response.json({ models: [null] })) as typeof fetch });
  deepEqual(ids(), [astra, newModel], 'malformed responses do not destroy a valid cache');

  const command = builtinSlashCommands.find(command => command.name === 'model')!;
  await rejects((async () => command.execute({} as SlashCommandContext, { raw: `/model ${daybreak}`, invocation: 'model', argsText: daybreak, argv: [daybreak] }))(), /unknown \/model model/, 'explicit /model cannot select a hidden catalog model');
  await refreshOpenAIModelAccess({ authPath, fetch: (async () => new Response('', { status: 403 })) as typeof fetch });
  deepEqual(ids(), [], 'access denial clears the active catalog');
  equal((await readdir(cacheDirectory)).length, 0, 'access denial invalidates the disk cache');

  await refreshOpenAIModelAccess(options);
  await saveStoredOpenAIAuth({ ...oauth, accountId: 'different-account' }, authPath);
  await loadOpenAIModelCache(options);
  check(!ids().includes(astra) && !ids().includes(newModel), 'another account never inherits a previous catalog');
  await saveStoredOpenAIAuth({ version: 1, provider: 'openai', method: 'api-key', apiKey: 'sk-model-test', updatedAt: new Date().toISOString() }, authPath);
  await loadOpenAIModelCache({ authPath });
  await refreshOpenAIModelAccess({ authPath, fetch: (async (url, init) => {
    equal(String(url), 'https://api.openai.com/v1/models', 'API-key discovery uses the API catalog');
    equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-model-test', 'API catalog uses the active credential');
    return Response.json({ data: [{ id: astra }, { id: 'daybreak-blue-latest' }, { id: newModel }] });
  }) as typeof fetch });
  deepEqual(ids(), [astra, daybreak, newModel], 'API model discovery includes new IDs and preserves the Daybreak alias');
  equal(getOpenAIProviderModelId(daybreak), 'daybreak-blue-latest', 'API Daybreak requests use the catalog provider ID');
  await expireCaches();
  await refreshOpenAIModelAccess({ authPath, fetch: (async () => {
    resetOpenAIModelAccess();
    return Response.json({ data: [{ id: astra }] });
  }) as typeof fetch });
  check(!ids().includes(astra), 'logout invalidates an in-flight catalog result');
  for (const name of await readdir(cacheDirectory)) await writeFile(join(cacheDirectory, name), '{broken');
  await loadOpenAIModelCache({ authPath });
  check(!ids().includes(astra), 'corrupt caches safely fall back without granting access');
} finally {
  resetOpenAIModelAccess();
  await rm(directory, { recursive: true, force: true });
}

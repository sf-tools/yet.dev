import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAvailableOpenAIModels, refreshOpenAIModelAccess, resetOpenAIModelAccess } from '@/auth/models';
import { saveStoredOpenAIAuth } from '@/auth/storage';
import { getOpenAIContextWindow, getOpenAIProviderModelId, getSupportedThinkingModes } from '@/config';
import { builtinSlashCommands, createSlashCommandRegistry, type SlashCommandContext } from '@/agent/slash-commands';
import { check, deepEqual, equal, rejects } from './harness';

const directory = await mkdtemp(join(tmpdir(), 'yet-models-test-'));
const authPath = join(directory, 'auth.json');
const registry = createSlashCommandRegistry(builtinSlashCommands);
const suggestions = () => registry.listSuggestions({ type: 'argument', invocation: 'model', query: '' });
const visible = (id: string) => getAvailableOpenAIModels().some(model => model.id === id);
const astra = 'gpt-6-astra';
const daybreak = 'gpt-daybreak-blue-latest';

try {
  resetOpenAIModelAccess();
  check(!visible(astra) && !visible(daybreak), 'restricted models start hidden');
  equal(getOpenAIProviderModelId(astra), astra, 'Astra uses its exact provider model ID');
  equal(getOpenAIContextWindow(astra), 272_000, 'Astra uses the Codex default context window');
  deepEqual(getSupportedThinkingModes(astra), ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'Astra exposes the Codex reasoning levels');
  await saveStoredOpenAIAuth({ version: 1, provider: 'openai', method: 'api-key', apiKey: 'sk-model-test', updatedAt: new Date().toISOString() }, authPath);
  await refreshOpenAIModelAccess({ authPath, fetch: (async (url, init) => {
    equal(String(url), 'https://api.openai.com/v1/models', 'API-key model discovery uses the API catalog');
    equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-model-test', 'catalog uses the active credential');
    return Response.json({ data: [{ id: astra }, { id: 'daybreak-blue-latest' }] });
  }) as typeof fetch });
  check(visible(astra) && visible(daybreak), 'API catalog enables Astra and the Daybreak provider alias');
  equal(suggestions().length, 9, 'existing picker observes refreshed account access');

  await saveStoredOpenAIAuth({ version: 1, provider: 'openai', method: 'oauth', accessToken: 'oauth-model-test', refreshToken: 'refresh-model-test', idToken: 'id-model-test', accountId: 'model-account', expiresAt: Date.now() + 3_600_000, updatedAt: new Date().toISOString() }, authPath);
  await refreshOpenAIModelAccess({ authPath, fetch: (async (url, init) => {
    check(String(url).endsWith('/codex/models?client_version=0.153.0'), 'ChatGPT discovery sends the Astra-compatible catalog version');
    equal((init?.headers as Record<string, string>)['ChatGPT-Account-ID'], 'model-account', 'ChatGPT catalog is scoped to the selected account');
    return Response.json({ models: [{ slug: astra, visibility: 'list' }, { slug: daybreak, visibility: 'hide' }] });
  }) as typeof fetch });
  check(visible(astra) && !visible(daybreak), 'account switch discards old access and respects hidden catalog entries');
  equal(suggestions().length, 8, 'picker removes models hidden by the new account');
  const command = builtinSlashCommands.find(command => command.name === 'model')!;
  await rejects((async () => command.execute({} as SlashCommandContext, { raw: `/model ${daybreak}`, invocation: 'model', argsText: daybreak, argv: [daybreak] }))(), /unknown \/model model/, 'explicit /model cannot select an unavailable model');

  await refreshOpenAIModelAccess({ authPath, fetch: (async () => new Response('', { status: 403 })) as typeof fetch });
  check(!visible(astra) && !visible(daybreak), 'failed catalog lookup hides restricted models');
  await refreshOpenAIModelAccess({ authPath, fetch: (async () => Response.json({ models: [null, {}, { slug: astra }] })) as typeof fetch });
  check(!visible(astra), 'malformed or unlisted entries do not grant access');
  await refreshOpenAIModelAccess({ authPath, fetch: (async () => {
    resetOpenAIModelAccess();
    return Response.json({ models: [{ slug: astra, visibility: 'list' }] });
  }) as typeof fetch });
  check(!visible(astra), 'logout invalidates an in-flight catalog result');
} finally {
  resetOpenAIModelAccess();
  await rm(directory, { recursive: true, force: true });
}

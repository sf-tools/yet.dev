import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  OPENAI_MODEL_OPTIONS,
  isThinkingMode,
  setOpenAIModelCatalog,
  type OpenAIModelOption,
  type ThinkingMode,
} from '@/config/models';
import { resolveOpenAIConnection } from './openai';
import { loadStoredOpenAIAuth, YET_AUTH_PATH } from './storage';
import type { StoredOpenAIAuth } from './types';
import { readCodexInstructions } from '@/config/model-instructions';

export { getAvailableOpenAIModels } from '@/config/models';

// Match the Astra-compatible Codex catalog and its five-minute cache TTL.
const CODEX_MODELS_CLIENT_VERSION = '0.153.0';
const CACHE_TTL_MS = 5 * 60_000;
type CatalogOptions = Parameters<typeof resolveOpenAIConnection>[0];
type CacheEntry = {
  version: 1;
  clientVersion: string;
  accountKey: string;
  fetchedAt: number;
  codex: boolean;
  models: unknown[];
};
let accountKey: string | null = null;
let fetchedAt = 0;
let generation = 0;

function identity(auth: StoredOpenAIAuth) {
  // OAuth access tokens rotate; the user and selected workspace do not.
  let subject = '';
  if (auth.method === 'oauth') {
    try {
      const claims = JSON.parse(Buffer.from(auth.idToken.split('.')[1] ?? '', 'base64url').toString());
      if (typeof claims.sub === 'string') subject = claims.sub;
    } catch {}
  }
  return createHash('sha256').update(JSON.stringify(auth.method === 'api-key'
    ? ['api-key', auth.apiKey]
    : ['oauth', auth.accountId, subject || auth.email || '', Boolean(auth.fedramp)],
  )).digest('hex');
}

function cachePath(key: string, options: CatalogOptions = {}) {
  return join(dirname(options.authPath ?? YET_AUTH_PATH), 'models-cache', `${key}.json`);
}

function parseCatalog(models: unknown, codex: boolean): OpenAIModelOption[] | null {
  if (!Array.isArray(models)) return null;
  const result: OpenAIModelOption[] = [];
  for (const value of models) {
    if (!value || typeof value !== 'object') return null;
    const model = value as Record<string, unknown>;
    const id = codex ? model.slug : model.id;
    if (typeof id !== 'string' || !id.trim()) return null;
    const known = OPENAI_MODEL_OPTIONS.find(option => option.id === id || option.providerId === id);
    const efforts: ThinkingMode[] = ['auto'];
    if (Array.isArray(model.supported_reasoning_levels)) {
      for (const level of model.supported_reasoning_levels) {
        if (level && isThinkingMode(level.effort) && !efforts.includes(level.effort)) efforts.push(level.effort);
      }
    } else if (known) efforts.push(...known.efforts.filter(effort => effort !== 'auto'));
    result.push({
      id: known?.id ?? id,
      providerId: id,
      label: typeof model.display_name === 'string' ? model.display_name : known?.label ?? id,
      description: typeof model.description === 'string' ? model.description : known?.description ?? '',
      contextWindow: typeof model.context_window === 'number' && model.context_window > 0
        ? model.context_window : known?.contextWindow ?? null,
      efforts,
      showInPicker: !codex || model.visibility === 'list',
      ...(codex ? { instructions: readCodexInstructions(model) } : {}),
    });
  }
  return result;
}

export function resetOpenAIModelAccess() {
  generation += 1;
  accountKey = null;
  fetchedAt = 0;
  setOpenAIModelCatalog(null);
}

// Local disk only: this must never refresh OAuth tokens or wait for the network.
export async function loadOpenAIModelCache(options: CatalogOptions = {}) {
  resetOpenAIModelAccess();
  const current = generation;
  try {
    const auth = await loadStoredOpenAIAuth(options.authPath);
    if (!auth || current !== generation) return;
    const key = identity(auth);
    accountKey = key;
    const entry = JSON.parse(await readFile(cachePath(key, options), 'utf8')) as CacheEntry;
    if (current !== generation || entry.version !== 1 || entry.accountKey !== key ||
      entry.clientVersion !== CODEX_MODELS_CLIENT_VERSION ||
      entry.codex !== (auth.method === 'oauth') ||
      !Number.isFinite(entry.fetchedAt) || entry.fetchedAt > Date.now()) return;
    const catalog = parseCatalog(entry.models, entry.codex);
    if (!catalog) return;
    fetchedAt = entry.fetchedAt;
    setOpenAIModelCatalog(catalog);
  } catch {
    // Missing/corrupt caches use the bundled fallback until discovery finishes.
  }
}

export async function refreshOpenAIModelAccess(options: CatalogOptions = {}) {
  const current = generation;
  let temporaryPath: string | undefined;
  try {
    const auth = await loadStoredOpenAIAuth(options.authPath);
    if (!auth || current !== generation) return;
    const key = identity(auth);
    if (accountKey !== key) {
      await loadOpenAIModelCache(options);
      if (accountKey !== key) return;
      return refreshOpenAIModelAccess(options);
    }
    if (fetchedAt && Date.now() - fetchedAt < CACHE_TTL_MS) return;
    const connection = await resolveOpenAIConnection(options);
    if (current !== generation) return;
    const codex = auth.method === 'oauth';
    const baseURL = connection.baseURL ?? 'https://api.openai.com/v1';
    const url = `${baseURL}/models${codex ? `?client_version=${CODEX_MODELS_CLIENT_VERSION}` : ''}`;
    const response = await (options.fetch ?? fetch)(url, {
      headers: { authorization: `Bearer ${connection.apiKey}`, ...connection.defaultHeaders },
      signal: AbortSignal.timeout(5_000),
    });
    if (current !== generation) return;
    if (response.status === 401 || response.status === 403) {
      setOpenAIModelCatalog([]);
      fetchedAt = 0;
      await rm(cachePath(key, options), { force: true });
      return;
    }
    if (!response.ok) return;
    const body = await response.json();
    const models = codex ? body?.models : body?.data;
    const catalog = parseCatalog(models, codex);
    if (!catalog || current !== generation) return;
    const entry: CacheEntry = {
      version: 1, clientVersion: CODEX_MODELS_CLIENT_VERSION, accountKey: key,
      fetchedAt: Date.now(), codex,
      // Persist the resolved instructions so offline startup keeps the model's prompt.
      models: catalog.map(model => ({
        ...(codex ? { slug: model.providerId } : { id: model.providerId }),
        display_name: model.label,
        description: model.description,
        context_window: model.contextWindow,
        supported_reasoning_levels: model.efforts.filter(effort => effort !== 'auto').map(effort => ({ effort })),
        visibility: model.showInPicker ? 'list' : 'hide',
        ...(model.instructions ? { base_instructions: model.instructions } : {}),
      })),
    };
    fetchedAt = entry.fetchedAt;
    setOpenAIModelCatalog(catalog);
    const path = cachePath(key, options);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
    if (current === generation) await rename(temporaryPath, path);
  } catch {
    // A transient failure keeps the current account's cached catalog usable.
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

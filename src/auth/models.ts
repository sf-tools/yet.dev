import { OPENAI_MODEL_OPTIONS } from '@/config/models';
import { resolveOpenAIConnection } from './openai';

// Astra's minimum catalog client version in the Codex reference checkout.
const CODEX_MODELS_CLIENT_VERSION = '0.153.0';
let accountModelIds = new Set<string>();
let refreshGeneration = 0;

export function getAvailableOpenAIModels() {
  return OPENAI_MODEL_OPTIONS.filter(option =>
    !option.requiresAccountSupport ||
    accountModelIds.has(option.id) || accountModelIds.has(option.providerId),
  );
}

export function resetOpenAIModelAccess() {
  refreshGeneration += 1;
  accountModelIds = new Set();
}

export async function refreshOpenAIModelAccess(
  options: Parameters<typeof resolveOpenAIConnection>[0] = {},
) {
  resetOpenAIModelAccess();
  const generation = refreshGeneration;
  try {
    const connection = await resolveOpenAIConnection(options);
    const codex = Boolean(connection.baseURL);
    const baseURL = connection.baseURL ?? 'https://api.openai.com/v1';
    const url = `${baseURL}/models${codex ? `?client_version=${CODEX_MODELS_CLIENT_VERSION}` : ''}`;
    const response = await (options.fetch ?? fetch)(url, {
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        ...connection.defaultHeaders,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const body = await response.json();
    const models = codex ? body?.models : body?.data;
    if (!Array.isArray(models)) return;
    const ids = models.flatMap(model => {
      if (!model || typeof model !== 'object') return [];
      // Hidden Codex entries are not offered in its model picker either.
      if (codex && model.visibility !== 'list') return [];
      const id = codex ? model.slug : model.id;
      return typeof id === 'string' ? [id] : [];
    });
    if (generation === refreshGeneration) accountModelIds = new Set(ids);
  } catch {
    // Without confirmation from the current account, gated models stay hidden.
  }
}

const crypto = require('node:crypto');
const net = require('node:net');

const BUILTIN_PROVIDERS = new Set(['vercel-ai-gateway', 'openai']);
const CUSTOM_PROVIDER_PREFIX = 'custom:';
const API_FORMATS = new Set(['responses', 'chat-completions']);
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DEFAULT_GATEWAY_MODEL = 'openai/gpt-4.1-mini';
const DEFAULT_SUMMARY_MAX_CHARS = 300;
const MIN_SUMMARY_MAX_CHARS = 100;
const MAX_SUMMARY_MAX_CHARS = 2000;
const MODEL_OPTIONS = [
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', input: 0.1, output: 0.5 },
  { id: 'openai/gpt-5.4-nano', name: 'GPT-5.4 Nano', input: 0.2, output: 1.25 },
  { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', input: 0.4, output: 1.6 },
  { id: 'openai/gpt-6.1-terra', name: 'GPT-6.1 Terra', input: 1, output: 5 },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', input: 2, output: 10 },
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', input: 10, output: 50 },
];

function unavailable() {
  return Object.assign(new Error('Yapay zeka bağlantısı henüz kullanıma hazır değil.'), { code: 503 });
}
function bad(message) {
  return Object.assign(new Error(message), { code: 400 });
}
function credentialKey() {
  const raw = process.env.AI_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw unavailable();
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-ai-settings-v1', 32),
  );
}
function sealApiKey(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), nonce);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString(
    'base64',
  );
}
function openApiKey(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 29) throw unavailable();
  const cipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
}
function customId(value) {
  return typeof value === 'string' && /^cp_[a-f0-9]{24}$/i.test(value) ? value : '';
}
function customSelection(value) {
  return typeof value === 'string' && value.startsWith(CUSTOM_PROVIDER_PREFIX)
    ? customId(value.slice(CUSTOM_PROVIDER_PREFIX.length))
    : '';
}
function cleanProviderName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
  return name.length >= 2 && name.length <= 80 ? name : '';
}
function cleanBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return '';
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !hostname ||
      net.isIP(hostname) ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    )
      return '';
    return url.href.replace(/\/+$/u, '');
  } catch {
    return '';
  }
}
function cleanModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return MODEL_PATTERN.test(model) ? model : '';
}
function cleanReasoningEffort(value) {
  return REASONING_EFFORTS.has(value) ? value : 'none';
}
function cleanApiFormat(value) {
  return API_FORMATS.has(value) ? value : 'responses';
}
function normalizeCustomProvider(value) {
  const id = customId(value?.id);
  const name = cleanProviderName(value?.name);
  const baseUrl = cleanBaseUrl(value?.baseUrl);
  const model = cleanModel(value?.model);
  if (!id || !name || !baseUrl || !model) return null;
  return {
    id,
    name,
    baseUrl,
    model,
    apiFormat: cleanApiFormat(value.apiFormat),
    reasoningEffort: cleanReasoningEffort(value.reasoningEffort),
    sealedApiKey: typeof value.sealedApiKey === 'string' ? value.sealedApiKey : '',
  };
}
function defaultConfig() {
  return {
    enabled: true,
    provider: 'vercel-ai-gateway',
    model: process.env.AI_GATEWAY_MODEL || DEFAULT_GATEWAY_MODEL,
    reasoningEffort: 'none',
    summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
    sealedApiKey: '',
    customProviders: [],
  };
}
function normalized(saved = {}) {
  const fallback = defaultConfig();
  const customProviders = Array.isArray(saved.customProviders)
    ? saved.customProviders.map(normalizeCustomProvider).filter(Boolean).slice(0, 12)
    : [];
  const selectedCustom = customSelection(saved.provider);
  const provider =
    BUILTIN_PROVIDERS.has(saved.provider) || customProviders.some((item) => item.id === selectedCustom)
      ? saved.provider
      : fallback.provider;
  const activeCustom = customProviders.find((item) => item.id === customSelection(provider));
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : fallback.enabled,
    provider,
    model: activeCustom?.model || cleanModel(saved.model) || fallback.model,
    reasoningEffort: activeCustom?.reasoningEffort || cleanReasoningEffort(saved.reasoningEffort),
    summaryMaxChars: Number.isInteger(saved.summaryMaxChars)
      ? Math.min(MAX_SUMMARY_MAX_CHARS, Math.max(MIN_SUMMARY_MAX_CHARS, saved.summaryMaxChars))
      : fallback.summaryMaxChars,
    sealedApiKey: typeof saved.sealedApiKey === 'string' ? saved.sealedApiKey : '',
    customProviders,
  };
}
function summaryMaxChars(saved = {}) {
  return normalized(saved).summaryMaxChars;
}
function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiFormat: provider.apiFormat,
    reasoningEffort: provider.reasoningEffort,
    apiKeySaved: Boolean(provider.sealedApiKey),
  };
}
function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function usageSummary(saved = {}) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const models = Object.entries(source.models || {})
    .map(([model, row]) => ({
      model,
      requests: safeTokenCount(row?.requests),
      inputTokens: safeTokenCount(row?.inputTokens),
      outputTokens: safeTokenCount(row?.outputTokens),
      totalTokens: safeTokenCount(row?.totalTokens),
    }))
    .filter((row) => row.requests || row.totalTokens)
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
    .slice(0, 20);
  return {
    requests: safeTokenCount(source.requests),
    inputTokens: safeTokenCount(source.inputTokens),
    outputTokens: safeTokenCount(source.outputTokens),
    totalTokens: safeTokenCount(source.totalTokens),
    lastUsedAt: typeof source.lastUsedAt === 'string' ? source.lastUsedAt : '',
    models,
  };
}
function addUsage(saved, usage) {
  const current = usageSummary(saved);
  const inputTokens = safeTokenCount(usage?.inputTokens);
  const outputTokens = safeTokenCount(usage?.outputTokens);
  const totalTokens = safeTokenCount(usage?.totalTokens) || inputTokens + outputTokens;
  const model = typeof usage?.model === 'string' && usage.model.length <= 128 ? usage.model : 'unknown';
  if (!totalTokens) return current;
  const allModels = saved?.models && typeof saved.models === 'object' ? saved.models : {};
  const previous = {
    requests: safeTokenCount(allModels[model]?.requests),
    inputTokens: safeTokenCount(allModels[model]?.inputTokens),
    outputTokens: safeTokenCount(allModels[model]?.outputTokens),
    totalTokens: safeTokenCount(allModels[model]?.totalTokens),
  };
  const models = { ...allModels };
  models[model] = {
    requests: previous.requests + 1,
    inputTokens: previous.inputTokens + inputTokens,
    outputTokens: previous.outputTokens + outputTokens,
    totalTokens: previous.totalTokens + totalTokens,
  };
  return {
    requests: current.requests + 1,
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    totalTokens: current.totalTokens + totalTokens,
    lastUsedAt: new Date().toISOString(),
    models,
  };
}
function publicConfig(saved = {}, usage) {
  const config = normalized(saved);
  const gatewayCredentialAvailable = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  const selectedCustom = config.customProviders.find((item) => item.id === customSelection(config.provider));
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    summaryMaxChars: config.summaryMaxChars,
    modelOptions: MODEL_OPTIONS,
    customProviders: config.customProviders.map(publicProvider),
    usage: usageSummary(usage),
    apiKeySaved: Boolean(selectedCustom?.sealedApiKey || (!selectedCustom && config.sealedApiKey)),
    encryptionReady: (() => {
      try {
        credentialKey();
        return true;
      } catch {
        return false;
      }
    })(),
    runtimeReady:
      !config.enabled ||
      (config.provider === 'vercel-ai-gateway'
        ? gatewayCredentialAvailable
        : Boolean(selectedCustom?.sealedApiKey || (!selectedCustom && config.sealedApiKey))),
  };
}
function commonInput(input) {
  const provider = input?.provider;
  const model = cleanModel(input?.model);
  const summary = Number(input?.summaryMaxChars);
  if (typeof input?.enabled !== 'boolean') throw bad('Otomatik özet ayarı geçersiz.');
  if (!model) throw bad('Geçerli bir model adı girin.');
  if (!Number.isInteger(summary) || summary < MIN_SUMMARY_MAX_CHARS || summary > MAX_SUMMARY_MAX_CHARS)
    throw bad(
      `Özet uzunluğu ${MIN_SUMMARY_MAX_CHARS} ile ${MAX_SUMMARY_MAX_CHARS} karakter arasında olmalıdır.`,
    );
  if (!BUILTIN_PROVIDERS.has(provider) && provider !== 'custom:new' && !customSelection(provider))
    throw bad('Geçerli bir yapay zeka sağlayıcısı seçin.');
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean')
    throw bad('API anahtarı ayarı geçersiz.');
  if (input.deleteCustomProvider !== undefined && typeof input.deleteCustomProvider !== 'boolean')
    throw bad('Sağlayıcı silme ayarı geçersiz.');
  const apiKey = input?.apiKey === undefined ? '' : input.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length > 512 || (apiKey && /[\u0000-\u001f\u007f]/u.test(apiKey)))
    throw bad('API anahtarı biçimi geçersiz.');
  return {
    provider,
    model,
    summaryMaxChars: summary,
    reasoningEffort: cleanReasoningEffort(input?.reasoningEffort),
    apiKey: apiKey.trim(),
  };
}
function customFromInput(input, existing, { requireKey = false } = {}) {
  const name = cleanProviderName(input?.providerName);
  const baseUrl = cleanBaseUrl(input?.baseUrl);
  const model = cleanModel(input?.model);
  if (!name) throw bad('Sağlayıcı adı 2 ile 80 karakter arasında olmalıdır.');
  if (!baseUrl)
    throw bad(
      'Base URL HTTPS olmalı; kullanıcı bilgisi, port, sorgu parametresi ve yerel ağ adresi içermemelidir.',
    );
  if (!model) throw bad('Geçerli bir model adı girin.');
  const apiKey = input?.apiKey === undefined ? '' : String(input.apiKey).trim();
  let sealedApiKey = existing?.sealedApiKey || '';
  if (input?.clearApiKey === true) sealedApiKey = '';
  if (apiKey) sealedApiKey = sealApiKey(apiKey);
  if (requireKey && !sealedApiKey) throw bad('Özel sağlayıcıyı etkinleştirmeden önce API anahtarını girin.');
  return {
    id: existing?.id || 'cp_' + crypto.randomBytes(12).toString('hex'),
    name,
    baseUrl,
    model,
    apiFormat: cleanApiFormat(input?.apiFormat),
    reasoningEffort: cleanReasoningEffort(input?.reasoningEffort),
    sealedApiKey,
  };
}
function configure(saved, input) {
  const current = normalized(saved);
  const request = commonInput(input);
  let provider = request.provider;
  let customProviders = current.customProviders;
  let model = request.model;
  let reasoningEffort = request.reasoningEffort;
  let sealedApiKey = provider === 'openai' ? current.sealedApiKey : '';
  const selectedId = customSelection(provider);
  if (selectedId || provider === 'custom:new') {
    const existing = customProviders.find((item) => item.id === selectedId);
    if (selectedId && !existing) throw bad('Seçilen özel sağlayıcı bulunamadı.');
    if (input.deleteCustomProvider === true) {
      if (!existing) throw bad('Silinecek özel sağlayıcı bulunamadı.');
      customProviders = customProviders.filter((item) => item.id !== existing.id);
      provider = 'vercel-ai-gateway';
      model = current.model;
      reasoningEffort = current.reasoningEffort;
    } else {
      if (!existing && customProviders.length >= 12)
        throw bad('En fazla 12 özel sağlayıcı ekleyebilirsiniz.');
      const custom = customFromInput(input, existing, { requireKey: input.enabled });
      customProviders = existing
        ? customProviders.map((item) => (item.id === existing.id ? custom : item))
        : [...customProviders, custom];
      provider = CUSTOM_PROVIDER_PREFIX + custom.id;
      model = custom.model;
      reasoningEffort = custom.reasoningEffort;
    }
  } else {
    if (input.clearApiKey === true) sealedApiKey = '';
    if (request.apiKey) sealedApiKey = sealApiKey(request.apiKey);
    if (input.enabled && provider === 'openai' && !sealedApiKey)
      throw bad('OpenAI API için etkinleştirmeden önce API anahtarını girin.');
  }
  return {
    enabled: input.enabled,
    provider,
    model,
    reasoningEffort,
    summaryMaxChars: request.summaryMaxChars,
    sealedApiKey,
    customProviders,
  };
}
function endpointFor(baseUrl, apiFormat) {
  return (
    baseUrl.replace(/\/+$/u, '') + (apiFormat === 'chat-completions' ? '/chat/completions' : '/responses')
  );
}
function runtimeForCustom(provider, apiKey) {
  return {
    provider: CUSTOM_PROVIDER_PREFIX + provider.id,
    providerName: provider.name,
    model: provider.model,
    usageModel: `${provider.name}: ${provider.model}`.slice(0, 128),
    apiFormat: provider.apiFormat,
    reasoningEffort: provider.reasoningEffort,
    endpoint: endpointFor(provider.baseUrl, provider.apiFormat),
    authorization: 'Bearer ' + apiKey,
  };
}
function testInput(saved, input) {
  const current = normalized(saved);
  const request = commonInput({
    ...input,
    enabled: Boolean(input?.enabled ?? true),
    summaryMaxChars: input?.summaryMaxChars ?? 300,
  });
  if (request.provider === 'vercel-ai-gateway') {
    const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    if (!token)
      throw Object.assign(Error('Vercel AI Gateway kimlik doğrulaması kullanıma hazır değil.'), {
        code: 503,
      });
    return {
      provider: request.provider,
      model: request.model,
      usageModel: request.model,
      apiFormat: 'responses',
      reasoningEffort: request.reasoningEffort,
      endpoint: 'https://ai-gateway.vercel.sh/v1/responses',
      authorization: 'Bearer ' + token,
    };
  }
  if (request.provider === 'openai') {
    let token = request.apiKey;
    if (!token && current.provider === 'openai' && current.sealedApiKey)
      token = openApiKey(current.sealedApiKey);
    if (!token) throw bad('Test için OpenAI API anahtarını girin veya önce ayarları kaydedin.');
    return {
      provider: request.provider,
      model: request.model.replace(/^openai\//, ''),
      usageModel: request.model,
      apiFormat: 'responses',
      reasoningEffort: request.reasoningEffort,
      endpoint: 'https://api.openai.com/v1/responses',
      authorization: 'Bearer ' + token,
    };
  }
  const selectedId = customSelection(request.provider);
  const existing = current.customProviders.find((item) => item.id === selectedId);
  if (selectedId && !existing) throw bad('Seçilen özel sağlayıcı bulunamadı.');
  const name = cleanProviderName(input?.providerName) || existing?.name;
  const baseUrl = cleanBaseUrl(input?.baseUrl) || existing?.baseUrl;
  const model = cleanModel(input?.model) || existing?.model;
  if (!name || !baseUrl || !model) throw bad('Özel sağlayıcı adı, Base URL ve model bilgilerini girin.');
  let token = request.apiKey;
  if (!token && existing?.sealedApiKey) token = openApiKey(existing.sealedApiKey);
  if (!token) throw bad('Test için özel sağlayıcının API anahtarını girin veya önce ayarları kaydedin.');
  return runtimeForCustom(
    {
      id: existing?.id || 'test',
      name,
      baseUrl,
      model,
      apiFormat: cleanApiFormat(input?.apiFormat),
      reasoningEffort: request.reasoningEffort,
    },
    token,
  );
}
function providerTestError(status) {
  if (status === 401) return 'API anahtarı kabul edilmedi.';
  if (status === 402) return 'Sağlayıcı kredisi veya kullanım kotası yetersiz.';
  if (status === 403) return 'Bu anahtarın seçilen modele erişim yetkisi yok.';
  if (status === 404)
    return 'Seçilen model bulunamadı, Base URL yanlış veya bu API hesabında kullanıma açık değil.';
  if (status === 429) return 'Sağlayıcı hız veya kullanım kotası uyguluyor. Bir süre sonra tekrar deneyin.';
  if (status >= 500) return 'Yapay zeka sağlayıcısı geçici olarak yanıt vermiyor. Daha sonra tekrar deneyin.';
  return `Bağlantı testi başarısız oldu (HTTP ${status}).`;
}
function responseUsage(payload, model) {
  const usage = payload?.usage || {};
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const inputTokens = count(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
  const outputTokens = count(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
  const totalTokens = count(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;
  return totalTokens ? { model, inputTokens, outputTokens, totalTokens } : null;
}
function requestBody(runtime, { input, maxOutputTokens }) {
  if (runtime.apiFormat === 'chat-completions') {
    const messages = Array.isArray(input)
      ? input.map((item) => ({ role: item.role, content: item.content }))
      : [{ role: 'user', content: String(input) }];
    return {
      model: runtime.model,
      max_tokens: maxOutputTokens,
      ...(runtime.reasoningEffort !== 'none' ? { reasoning_effort: runtime.reasoningEffort } : {}),
      messages,
    };
  }
  return {
    model: runtime.model,
    max_output_tokens: maxOutputTokens,
    ...(runtime.reasoningEffort !== 'none' ? { reasoning: { effort: runtime.reasoningEffort } } : {}),
    input,
  };
}
async function testConnection(saved, input, { fetcher = fetch } = {}) {
  const runtime = testInput(saved, input);
  let response;
  try {
    response = await fetcher(runtime.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: runtime.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        requestBody(runtime, { input: 'Bağlantıyı doğrulamak için yalnızca OK yaz.', maxOutputTokens: 16 }),
      ),
    });
  } catch {
    throw Object.assign(Error('Yapay zeka sağlayıcısına bağlanılamadı. Ağ bağlantısını tekrar deneyin.'), {
      code: 502,
    });
  }
  if (!response.ok) throw Object.assign(Error(providerTestError(response.status)), { code: response.status });
  const payload = await response.json().catch(() => ({}));
  return {
    provider: runtime.provider,
    providerName: runtime.providerName || '',
    model: runtime.usageModel,
    usage: responseUsage(payload, runtime.usageModel),
  };
}
function runtimeConfig(saved) {
  const config = normalized(saved);
  if (!config.enabled) return null;
  if (config.provider === 'vercel-ai-gateway') {
    const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    if (!token) return null;
    return {
      provider: config.provider,
      model: config.model,
      usageModel: config.model,
      apiFormat: 'responses',
      reasoningEffort: config.reasoningEffort,
      endpoint: 'https://ai-gateway.vercel.sh/v1/responses',
      authorization: 'Bearer ' + token,
    };
  }
  if (config.provider === 'openai') {
    if (!config.sealedApiKey) return null;
    return {
      provider: config.provider,
      model: config.model.replace(/^openai\//, ''),
      usageModel: config.model,
      apiFormat: 'responses',
      reasoningEffort: config.reasoningEffort,
      endpoint: 'https://api.openai.com/v1/responses',
      authorization: 'Bearer ' + openApiKey(config.sealedApiKey),
    };
  }
  const custom = config.customProviders.find((item) => item.id === customSelection(config.provider));
  return custom?.sealedApiKey ? runtimeForCustom(custom, openApiKey(custom.sealedApiKey)) : null;
}
function configFingerprint(saved) {
  const config = normalized(saved);
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
module.exports = {
  DEFAULT_GATEWAY_MODEL,
  DEFAULT_SUMMARY_MAX_CHARS,
  MIN_SUMMARY_MAX_CHARS,
  MAX_SUMMARY_MAX_CHARS,
  MODEL_OPTIONS,
  REASONING_EFFORTS,
  publicConfig,
  configure,
  runtimeConfig,
  configFingerprint,
  summaryMaxChars,
  addUsage,
  testConnection,
  requestBody,
};

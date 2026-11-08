const crypto = require('node:crypto');

const PROVIDERS = new Set(['vercel-ai-gateway', 'openai']);
const DEFAULT_GATEWAY_MODEL = 'openai/gpt-4.1-mini';
// Curated from the live AI Gateway catalog on 2026-11-08. Prices are USD per
// million tokens and are shown only to help the CEO compare model tiers.
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

function credentialKey() {
  // A separate HKDF context prevents reuse of the backup/WhatsApp encryption key material.
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

function defaultConfig() {
  return {
    enabled: true,
    provider: 'vercel-ai-gateway',
    model: process.env.AI_GATEWAY_MODEL || DEFAULT_GATEWAY_MODEL,
    sealedApiKey: '',
  };
}

function normalized(saved = {}) {
  const fallback = defaultConfig();
  const provider = PROVIDERS.has(saved.provider) ? saved.provider : fallback.provider;
  const model =
    typeof saved.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(saved.model)
      ? saved.model
      : fallback.model;
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : fallback.enabled,
    provider,
    model,
    sealedApiKey: typeof saved.sealedApiKey === 'string' ? saved.sealedApiKey : '',
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
    model,
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
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    modelOptions: MODEL_OPTIONS,
    usage: usageSummary(usage),
    apiKeySaved: Boolean(config.sealedApiKey),
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
      (config.provider === 'vercel-ai-gateway' ? gatewayCredentialAvailable : Boolean(config.sealedApiKey)),
  };
}

function configure(saved, input) {
  const bad = (message) => Object.assign(new Error(message), { code: 400 });
  const current = normalized(saved);
  const provider = input?.provider;
  const model = String(input?.model || '').trim();
  const apiKey = input?.apiKey === undefined ? '' : input.apiKey;
  if (typeof input?.enabled !== 'boolean' || !PROVIDERS.has(provider))
    throw bad('Geçerli bir yapay zeka sağlayıcısı seçin.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw bad('Geçerli bir model adı girin.');
  if (
    typeof apiKey !== 'string' ||
    apiKey.length > 512 ||
    (apiKey && !/^[A-Za-z0-9._-]{20,512}$/.test(apiKey))
  )
    throw bad('API anahtarı biçimi geçersiz.');
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean')
    throw bad('API anahtarı ayarı geçersiz.');

  let sealedApiKey = provider === 'openai' ? current.sealedApiKey : '';
  if (input.clearApiKey === true) sealedApiKey = '';
  if (apiKey) sealedApiKey = sealApiKey(apiKey);
  if (input.enabled && provider === 'openai' && !sealedApiKey)
    throw bad('OpenAI API için etkinleştirmeden önce API anahtarını girin.');
  return { enabled: input.enabled, provider, model, sealedApiKey };
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
      endpoint: 'https://ai-gateway.vercel.sh/v1/responses',
      authorization: 'Bearer ' + token,
    };
  }
  if (!config.sealedApiKey) return null;
  return {
    provider: config.provider,
    // Direct OpenAI accepts the bare model ID; Gateway needs provider/model.
    model: config.model.replace(/^openai\//, ''),
    endpoint: 'https://api.openai.com/v1/responses',
    authorization: 'Bearer ' + openApiKey(config.sealedApiKey),
  };
}

function configFingerprint(saved) {
  const config = normalized(saved);
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

module.exports = {
  DEFAULT_GATEWAY_MODEL,
  MODEL_OPTIONS,
  publicConfig,
  configure,
  runtimeConfig,
  configFingerprint,
  addUsage,
};

const crypto = require('node:crypto');

const PROVIDERS = new Set(['vercel-ai-gateway', 'openai']);
const DEFAULT_GATEWAY_MODEL = 'openai/gpt-4.1-mini';

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

function publicConfig(saved = {}) {
  const config = normalized(saved);
  const gatewayCredentialAvailable = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
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
      (config.provider === 'vercel-ai-gateway'
        ? gatewayCredentialAvailable
        : Boolean(config.sealedApiKey)),
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))
    throw bad('Geçerli bir model adı girin.');
  if (typeof apiKey !== 'string' || apiKey.length > 512 || (apiKey && !/^[A-Za-z0-9._-]{20,512}$/.test(apiKey)))
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
    model: config.model,
    endpoint: 'https://api.openai.com/v1/responses',
    authorization: 'Bearer ' + openApiKey(config.sealedApiKey),
  };
}

function configFingerprint(saved) {
  const config = normalized(saved);
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

module.exports = { DEFAULT_GATEWAY_MODEL, publicConfig, configure, runtimeConfig, configFingerprint };

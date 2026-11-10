const crypto = require('node:crypto');
const net = require('node:net');
const { fold } = require('../outputs/icrapro/workspace-marketing-route.js');

// Firm sources for Rota Bulma: the official Google Places API, or a self-hosted
// gosom/google-maps-scraper service.
const SOURCES = Object.freeze(['google', 'scraper']);
const SOURCE_LABELS = Object.freeze({ google: 'Google Places API', scraper: 'Harita tarama (gosom)' });
const AUTH_HEADER = /^[\x20-\x7e]{1,500}$/;

const DEFAULT_SECTORS = Object.freeze([
  { id: 'beyaz-esya', label: 'Beyaz Eşya', query: 'beyaz eşya mağazası' },
  { id: 'mobilya', label: 'Mobilya', query: 'mobilya mağazası' },
  { id: 'hirdavat', label: 'Hırdavat', query: 'hırdavat' },
]);
const MAX_SECTORS = 30;
const API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
const SECTOR_TEXT = /^[\p{L}\p{N} .,'&()/-]+$/u;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
const bad = (message) => failure(400, message);

function credentialKey() {
  // A separate HKDF context keeps this key distinct from backup, WhatsApp and AI keys.
  const raw = process.env.MAPS_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw failure(
      503,
      'Anahtar şifrelemesi hazır değil. Sunucuda MAPS_ENCRYPTION_KEY veya BACKUP_ENCRYPTION_KEY tanımlayın.',
    );
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-maps-settings-v1', 32),
  );
}

function encryptionReady() {
  try {
    credentialKey();
    return true;
  } catch {
    return false;
  }
}

function seal(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), nonce);
  return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString(
    'base64',
  );
}

function open(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 29) throw failure(503, 'Kayıtlı anahtar okunamadı. Anahtarı yeniden girin.');
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
  } catch (error) {
    if (error.code === 503) throw error;
    throw failure(503, 'Kayıtlı anahtar okunamadı. Anahtarı yeniden girin.');
  }
}

// gosom has no authentication of its own. In the cloud it must sit behind a
// public HTTPS address (normally a reverse proxy with a password); a local
// installation may also use this computer's loopback address.
function scraperUrl(value, { allowLocal = false } = {}) {
  if (value === undefined || value === null || value === '') return '';
  const invalid = () =>
    bad(
      'Harita tarama sunucusu adresi https:// ile başlayan bir alan adı olmalıdır (ör. https://tarama.ornek.com)' +
        (allowLocal ? ' ya da bu bilgisayardaki http://127.0.0.1:8080 gibi bir adres.' : '.'),
    );
  if (typeof value !== 'string' || value.length > 300) throw invalid();
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.search || url.hash) throw invalid();
  if (['localhost', '127.0.0.1', '::1'].includes(host)) {
    if (!allowLocal || !['http:', 'https:'].includes(url.protocol)) throw invalid();
  } else if (
    url.protocol !== 'https:' ||
    net.isIP(host) ||
    !host.includes('.') ||
    /\.(localhost|local|internal)$/.test(host)
  )
    throw invalid();
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function authInput(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !AUTH_HEADER.test(value.trim()))
    throw bad('Erişim anahtarı tek satır olmalı ve en fazla 500 karakter içermelidir.');
  return value.trim();
}

const validUrl = (value, options) => {
  try {
    return scraperUrl(value, options);
  } catch {
    return '';
  }
};

function sectorId(label, used) {
  const base =
    fold(label)
      .replace(/ç/g, 'c')
      .replace(/ğ/g, 'g')
      .replace(/ö/g, 'o')
      .replace(/ş/g, 's')
      .replace(/ü/g, 'u')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'sektor';
  let id = base;
  for (let n = 2; used.has(id) || id === 'custom'; n++) id = base + '-' + n;
  used.add(id);
  return id;
}

// Throws on invalid input; `strict` is false when reading previously saved data.
function normalizeSectors(value, strict = true) {
  if (!Array.isArray(value) || !value.length) {
    if (strict) throw bad('En az bir sektör tanımlayın.');
    return DEFAULT_SECTORS.map((sector) => ({ ...sector }));
  }
  if (value.length > MAX_SECTORS) throw bad('En fazla ' + MAX_SECTORS + ' sektör tanımlanabilir.');
  const used = new Set(),
    labels = new Set();
  return value.map((item) => {
    const label = typeof item?.label === 'string' ? item.label.replace(/\s+/g, ' ').trim() : '';
    const query = typeof item?.query === 'string' ? item.query.replace(/\s+/g, ' ').trim() : label;
    if (label.length < 2 || label.length > 40 || !SECTOR_TEXT.test(label))
      throw bad('Sektör adı 2–40 karakter olmalı ve yalnızca harf, rakam ve noktalama içermelidir.');
    if (query.length < 2 || query.length > 80 || !SECTOR_TEXT.test(query))
      throw bad('Sektör arama ifadesi 2–80 karakter olmalıdır: ' + label);
    if (labels.has(fold(label))) throw bad('Aynı sektör iki kez tanımlanmış: ' + label);
    labels.add(fold(label));
    const id =
      typeof item.id === 'string' &&
      /^[a-z0-9-]{1,48}$/.test(item.id) &&
      !used.has(item.id) &&
      item.id !== 'custom'
        ? item.id
        : sectorId(label, used);
    used.add(id);
    return { id, label, query };
  });
}

function normalized(saved = {}) {
  let sectors;
  try {
    sectors = normalizeSectors(saved?.sectors, false);
  } catch {
    sectors = DEFAULT_SECTORS.map((sector) => ({ ...sector }));
  }
  return {
    enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : true,
    sealedApiKey: typeof saved?.sealedApiKey === 'string' ? saved.sealedApiKey : '',
    sectors,
    scraperEnabled: saved?.scraperEnabled === true,
    scraperUrl: typeof saved?.scraperUrl === 'string' ? saved.scraperUrl : '',
    sealedScraperAuth: typeof saved?.sealedScraperAuth === 'string' ? saved.sealedScraperAuth : '',
    defaultSource: SOURCES.includes(saved?.defaultSource) ? saved.defaultSource : 'google',
  };
}

// `allowLocal` is true only when the application itself runs on this computer.
function publicConfig(saved, { allowLocal = false } = {}) {
  const config = normalized(saved);
  const ready = encryptionReady();
  const googleReady = config.enabled && Boolean(config.sealedApiKey) && ready;
  const scraperReady =
    config.scraperEnabled &&
    Boolean(validUrl(config.scraperUrl, { allowLocal })) &&
    (!config.sealedScraperAuth || ready);
  return {
    enabled: config.enabled,
    apiKeySaved: Boolean(config.sealedApiKey),
    encryptionReady: ready,
    ready: googleReady,
    sectors: config.sectors,
    scraperEnabled: config.scraperEnabled,
    scraperUrl: config.scraperUrl,
    scraperAuthSaved: Boolean(config.sealedScraperAuth),
    scraperReady,
    allowLocal,
    defaultSource: config.defaultSource,
    sources: [
      { id: 'google', label: SOURCE_LABELS.google, ready: googleReady },
      { id: 'scraper', label: SOURCE_LABELS.scraper, ready: scraperReady },
    ],
  };
}

function apiKeyInput(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !API_KEY.test(value.trim()))
    throw bad('Google API anahtarı biçimi geçersiz. Anahtar "AIza" ile başlar ve 39 karakterdir.');
  return value.trim();
}

function configure(saved, input, { allowLocal = false } = {}) {
  const current = normalized(saved);
  if (typeof input?.enabled !== 'boolean') throw bad('Bağlantı durumunu seçin.');
  for (const key of ['clearApiKey', 'scraperEnabled', 'clearScraperAuth'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw bad('Bağlantı ayarı geçersiz.');
  if (input.defaultSource !== undefined && !SOURCES.includes(input.defaultSource))
    throw bad('Varsayılan kaynak geçersiz.');
  const apiKey = apiKeyInput(input.apiKey);
  const sectors = input.sectors === undefined ? current.sectors : normalizeSectors(input.sectors);
  let sealedApiKey = input.clearApiKey === true ? '' : current.sealedApiKey;
  if (apiKey) sealedApiKey = seal(apiKey);
  if (input.enabled && !sealedApiKey)
    throw bad('Google Places API’yi açmak için Google API anahtarını girin.');
  const scraperEnabled = input.scraperEnabled ?? current.scraperEnabled;
  const url =
    input.scraperUrl === undefined ? current.scraperUrl : scraperUrl(input.scraperUrl, { allowLocal });
  if (scraperEnabled && !url) throw bad('Harita taramayı açmak için tarama sunucusunun adresini girin.');
  const auth = authInput(input.scraperAuth);
  let sealedScraperAuth = input.clearScraperAuth === true ? '' : current.sealedScraperAuth;
  if (auth) sealedScraperAuth = seal(auth);
  return {
    enabled: input.enabled,
    sealedApiKey,
    sectors,
    scraperEnabled,
    scraperUrl: url,
    sealedScraperAuth,
    defaultSource: input.defaultSource ?? current.defaultSource,
  };
}

// The decrypted key never leaves the server; callers send it only to Google.
function runtimeKey(saved) {
  const config = normalized(saved);
  if (!config.enabled || !config.sealedApiKey) return '';
  return open(config.sealedApiKey);
}

// Lets the CEO test a key before saving it; falls back to the saved key.
function testKey(saved, input) {
  const typed = apiKeyInput(input?.apiKey);
  if (typed) return typed;
  const config = normalized(saved);
  if (!config.sealedApiKey) throw bad('Test için Google API anahtarını girin.');
  return open(config.sealedApiKey);
}

// The access key is sent only to the configured tarama sunucusu.
function runtimeScraper(saved, { allowLocal = false } = {}) {
  const config = normalized(saved);
  if (!config.scraperEnabled || !config.scraperUrl) return null;
  const url = validUrl(config.scraperUrl, { allowLocal });
  if (!url)
    throw failure(503, 'Kayıtlı tarama sunucusu adresi bu ortamda kullanılamaz. Ayarlardan güncelleyin.');
  return { url, authorization: config.sealedScraperAuth ? open(config.sealedScraperAuth) : '' };
}

// Lets the CEO test an address and key before saving them.
function testScraper(saved, input, { allowLocal = false } = {}) {
  const config = normalized(saved);
  const url = scraperUrl(input?.scraperUrl || config.scraperUrl, { allowLocal });
  if (!url) throw bad('Test için tarama sunucusunun adresini girin.');
  const typed = authInput(input?.scraperAuth);
  return { url, authorization: typed || (config.sealedScraperAuth ? open(config.sealedScraperAuth) : '') };
}

module.exports = {
  DEFAULT_SECTORS,
  SOURCES,
  publicConfig,
  configure,
  runtimeKey,
  testKey,
  runtimeScraper,
  testScraper,
  scraperUrl,
  normalizeSectors,
};

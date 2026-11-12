const crypto = require('node:crypto');

// Minimal iyzico client: IYZWSv2 request signing, Checkout Form (platform sales), payment
// links (offices collecting from their own customers) and credential test. Money is integer
// kuruş everywhere; iyzico's decimal strings are converted without floating point.
// Request signing and the response-signature rules follow https://docs.iyzico.com
// (HMACSHA256 auth, response signature validation).

const BASE_URLS = { sandbox: 'https://sandbox-api.iyzipay.com', live: 'https://api.iyzipay.com' };
const ALLOWED_BASES = new Set(Object.values(BASE_URLS));
const TIMEOUT_MS = 20000;
const KEY_PATTERN = /^[A-Za-z0-9_.-]{8,200}$/;
// iyzico asks for an identity number on every buyer. When the operator has none (for example
// a company that has not told us its tax number) the documented test value is sent; real
// numbers should be entered for live payments.
const PLACEHOLDER_IDENTITY = '11111111111';
// iyzico's payment link API requires a product image; a 1x1 transparent PNG satisfies it.
const BLANK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function formatPrice(kurus) {
  if (!Number.isSafeInteger(kurus) || kurus < 0) throw fail(400, 'Tutar geçersiz.');
  return `${Math.floor(kurus / 100)}.${String(kurus % 100).padStart(2, '0')}`;
}
function parsePriceKurus(value) {
  const match = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(String(value ?? '').trim());
  if (!match) return NaN;
  const fraction = (match[2] || '').padEnd(4, '0');
  // iyzico may return more than two decimals; anything beyond kuruş must be zero.
  if (/[1-9]/.test(fraction.slice(2))) return NaN;
  return Number(match[1]) * 100 + Number(fraction.slice(0, 2));
}
// Trailing zeros are dropped before signing prices ("50.00" -> "50", "10.510" -> "10.51").
function normalizePrice(value) {
  const text = String(value);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
const hmacHex = (secretKey, data) => crypto.createHmac('sha256', secretKey).update(data, 'utf8').digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// randomKey + uri path (without query) + body, HMAC-SHA256 with the secret key; the header is
// "IYZWSv2 " + base64("apiKey:<key>&randomKey:<rnd>&signature:<hex>").
function authorization({ apiKey, secretKey }, path, body, randomKey) {
  const signature = hmacHex(secretKey, randomKey + path + (body || ''));
  const raw = `apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`;
  return 'IYZWSv2 ' + Buffer.from(raw, 'utf8').toString('base64');
}

// A link handed back to an operator must point at iyzico itself, never at a host the
// response invented.
function trustedUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    ['iyzipay.com', 'iyzico.com', 'iyzi.link'].some((domain) => host === domain || host.endsWith('.' + domain))
  );
}

function resolveBase(input) {
  const base = BASE_URLS[input] || input;
  if (!ALLOWED_BASES.has(base)) throw fail(400, 'iyzico adresi geçersiz.');
  return base;
}

function createIyzico({ apiKey, secretKey, baseUrl = 'sandbox', fetcher = fetch, random = () => `${Date.now()}${crypto.randomInt(100000, 999999)}` } = {}) {
  if (!KEY_PATTERN.test(apiKey || '') || !KEY_PATTERN.test(secretKey || '')) throw fail(503, 'iyzico anahtarları tanımlı değil.');
  const base = resolveBase(baseUrl);

  async function call(method, path, payload) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const randomKey = random();
    let response;
    try {
      response = await fetcher(base + path, {
        method,
        headers: {
          Authorization: authorization({ apiKey, secretKey }, path, body, randomKey),
          'x-iyzi-rnd': randomKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body || undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw fail(502, 'iyzico ile bağlantı kurulamadı.');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw fail(502, 'iyzico yanıtı okunamadı.');
    }
    return data;
  }
  // iyzico reports business errors with status "failure" (HTTP 200 or 4xx).
  const failure = (data, fallback) =>
    fail(502, data?.errorMessage ? `iyzico: ${String(data.errorMessage).slice(0, 200)}` : fallback, { providerCode: data?.errorCode });

  return {
    baseUrl: base,

    // A harmless authenticated call: a wrong key or secret is reported as an error.
    async testCredentials() {
      const data = await call('POST', '/payment/bin/check', { locale: 'tr', conversationId: 'baglanti-testi', binNumber: '454671' });
      if (data?.status === 'success') return { ok: true };
      return { ok: false, message: data?.errorMessage ? String(data.errorMessage).slice(0, 200) : 'iyzico anahtarları kabul edilmedi.' };
    },

    async initializeCheckout({ conversationId, amountKurus, basketId, description, callbackUrl, buyer, ip }) {
      const price = formatPrice(amountKurus);
      if (amountKurus < 1) throw fail(400, 'Tutar geçersiz.');
      const address = { contactName: `${buyer.name} ${buyer.surname}`, city: buyer.city, country: 'Turkey', address: buyer.address };
      const data = await call('POST', '/payment/iyzipos/checkoutform/initialize/auth/ecom', {
        locale: 'tr',
        conversationId,
        price,
        paidPrice: price,
        currency: 'TRY',
        basketId,
        paymentGroup: 'PRODUCT',
        callbackUrl,
        enabledInstallments: [1],
        buyer: {
          id: buyer.id,
          name: buyer.name,
          surname: buyer.surname,
          identityNumber: buyer.identityNumber || PLACEHOLDER_IDENTITY,
          email: buyer.email,
          gsmNumber: buyer.gsmNumber || undefined,
          registrationAddress: buyer.address,
          city: buyer.city,
          country: 'Turkey',
          ip: ip || '127.0.0.1',
        },
        shippingAddress: address,
        billingAddress: address,
        basketItems: [{ id: basketId, name: description, category1: 'Yazılım', itemType: 'VIRTUAL', price }],
      });
      if (data?.status !== 'success') throw failure(data, 'iyzico ödeme formunu oluşturamadı.');
      if (!data.token || !data.paymentPageUrl) throw fail(502, 'iyzico yanıtı eksik.');
      if (data.signature && !safeEqual(hmacHex(secretKey, `${data.conversationId}:${data.token}`), data.signature))
        throw fail(502, 'iyzico yanıtı doğrulanamadı.');
      if (!trustedUrl(data.paymentPageUrl)) throw fail(502, 'iyzico yanıtı geçersiz.');
      return { token: data.token, paymentPageUrl: data.paymentPageUrl };
    },

    // Reads the payment result straight from iyzico by token; the browser redirect is never trusted.
    async retrieveCheckout(token, conversationId) {
      const data = await call('POST', '/payment/iyzipos/checkoutform/auth/ecom/detail', { locale: 'tr', conversationId, token });
      if (data?.status !== 'success') throw failure(data, 'iyzico ödeme sonucunu vermedi.');
      const expected = hmacHex(
        secretKey,
        [data.paymentStatus, data.paymentId, data.currency, data.basketId, data.conversationId, normalizePrice(data.paidPrice), normalizePrice(data.price), data.token].join(':'),
      );
      if (!data.signature || !safeEqual(expected, data.signature)) throw fail(502, 'iyzico yanıtı doğrulanamadı.');
      return {
        paid: data.paymentStatus === 'SUCCESS',
        paymentStatus: String(data.paymentStatus),
        paymentId: data.paymentId === undefined ? null : String(data.paymentId),
        conversationId: data.conversationId,
        basketId: data.basketId,
        currency: data.currency,
        priceKurus: parsePriceKurus(data.price),
        paidKurus: parsePriceKurus(data.paidPrice),
      };
    },

    // Shareable payment page for an office's own customer (no redirect or callback needed).
    async createPaymentLink({ name, description, amountKurus, conversationId }) {
      if (!Number.isSafeInteger(amountKurus) || amountKurus < 100) throw fail(400, 'Tutar en az 1,00 TL olmalıdır.');
      const data = await call('POST', '/v2/iyzilink/products', {
        locale: 'tr',
        conversationId,
        name,
        description,
        price: formatPrice(amountKurus),
        currencyCode: 'TRY',
        addressIgnorable: true,
        installmentRequested: false,
        encodedImageFile: BLANK_PNG,
      });
      if (data?.status !== 'success' || !data.data?.url) throw failure(data, 'iyzico ödeme linkini oluşturamadı.');
      if (!trustedUrl(data.data.url)) throw fail(502, 'iyzico yanıtı geçersiz.');
      return { url: data.data.url, token: data.data.token };
    },
  };
}

// Platform-wide account, taken from the environment. Returns null when not configured.
function iyzicoFromEnv(env = process.env, options = {}) {
  if (!env.IYZICO_API_KEY || !env.IYZICO_SECRET_KEY) return null;
  return createIyzico({ apiKey: env.IYZICO_API_KEY, secretKey: env.IYZICO_SECRET_KEY, baseUrl: env.IYZICO_BASE_URL || 'sandbox', ...options });
}

module.exports = {
  BASE_URLS,
  KEY_PATTERN,
  PLACEHOLDER_IDENTITY,
  authorization,
  createIyzico,
  formatPrice,
  iyzicoFromEnv,
  normalizePrice,
  parsePriceKurus,
  resolveBase,
  trustedUrl,
};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createIyzico, formatPrice, parsePriceKurus, normalizePrice, resolveBase, trustedUrl, authorization, iyzicoFromEnv,
} = require('../lib/iyzico.cjs');

const API_KEY = 'sandbox-api-key-123';
const SECRET = 'sandbox-secret-key-456';
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data, 'utf8').digest('hex');
const buyer = { id: 'tenant-1', name: 'Ada', surname: 'Yönetici', email: 'ada@example.com', address: 'Örnek Mah. 1', city: 'İstanbul' };

// A fake iyzico that re-derives the request signature the documented way and rejects
// anything it does not match, then answers with whatever the test needs.
function fakeIyzico(handler) {
  const requests = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body || '';
    const randomKey = options.headers['x-iyzi-rnd'];
    const header = options.headers.Authorization;
    assert.match(header, /^IYZWSv2 [A-Za-z0-9+/=]+$/);
    const decoded = Buffer.from(header.slice(8), 'base64').toString('utf8');
    const expected = `apiKey:${API_KEY}&randomKey:${randomKey}&signature:${hmac(randomKey + path + body)}`;
    requests.push({ url, path, method: options.method, body: body ? JSON.parse(body) : undefined, signed: decoded === expected, headers: options.headers });
    const answer = handler({ path, body: body ? JSON.parse(body) : undefined, signed: decoded === expected });
    return { ok: true, status: 200, json: async () => answer };
  };
  return { fetcher, requests };
}
const client = (handler, extra = {}) => {
  const fake = fakeIyzico(handler);
  return { ...fake, iyzico: createIyzico({ apiKey: API_KEY, secretKey: SECRET, baseUrl: 'sandbox', fetcher: fake.fetcher, random: () => '1700000000000123456', ...extra }) };
};

test('prices convert between integer kuruş and iyzico decimals without floats', () => {
  assert.equal(formatPrice(0), '0.00');
  assert.equal(formatPrice(5), '0.05');
  assert.equal(formatPrice(125050), '1250.50');
  assert.equal(formatPrice(100_000_000_000_000), '1000000000000.00');
  for (const bad of [-1, 1.5, NaN, '10']) assert.throws(() => formatPrice(bad), (e) => e.status === 400, String(bad));
  assert.equal(parsePriceKurus('1250.5'), 125050);
  assert.equal(parsePriceKurus('1250.50'), 125050);
  assert.equal(parsePriceKurus('1250.5000'), 125050);
  assert.equal(parsePriceKurus('50'), 5000);
  assert.ok(Number.isNaN(parsePriceKurus('1250.505')), 'sub-kuruş remainder is rejected');
  for (const bad of ['', 'abc', '-5', '1e3', '1,5', undefined, '9'.repeat(14)]) assert.ok(Number.isNaN(parsePriceKurus(bad)), String(bad));
  assert.equal(normalizePrice('50.00'), '50');
  assert.equal(normalizePrice('10.510'), '10.51');
  assert.equal(normalizePrice('100'), '100', 'no decimal point: nothing to strip');
  assert.equal(normalizePrice('0.50'), '0.5');
});

test('request signing follows the documented IYZWSv2 scheme', () => {
  const header = authorization({ apiKey: API_KEY, secretKey: SECRET }, '/payment/bin/check', '{"a":1}', 'RND123');
  const raw = Buffer.from(header.replace('IYZWSv2 ', ''), 'base64').toString('utf8');
  assert.equal(raw, `apiKey:${API_KEY}&randomKey:RND123&signature:${hmac('RND123/payment/bin/check{"a":1}')}`);
  assert.equal(header.startsWith('IYZWSv2 '), true);
});

test('keys and base URLs are validated; only iyzico hosts are reachable or trusted', () => {
  assert.throws(() => createIyzico({ apiKey: '', secretKey: SECRET }), (e) => e.status === 503);
  assert.throws(() => createIyzico({ apiKey: 'bad key!', secretKey: SECRET }), (e) => e.status === 503);
  assert.equal(resolveBase('sandbox'), 'https://sandbox-api.iyzipay.com');
  assert.equal(resolveBase('live'), 'https://api.iyzipay.com');
  for (const bad of ['http://api.iyzipay.com', 'https://evil.example', 'https://api.iyzipay.com.evil.example', 'file:///etc/passwd'])
    assert.throws(() => resolveBase(bad), (e) => e.status === 400, bad);
  for (const ok of ['https://sandbox-cpp.iyzipay.com/?token=x', 'https://iyzi.link/ABC', 'https://www.iyzico.com/x'])
    assert.equal(trustedUrl(ok), true, ok);
  for (const bad of ['http://iyzi.link/ABC', 'https://iyzi.link.evil.example/', 'https://eviliyzipay.com/', 'javascript:alert(1)', 'nope', '', undefined])
    assert.equal(trustedUrl(bad), false, String(bad));
  assert.equal(iyzicoFromEnv({}), null);
  assert.equal(iyzicoFromEnv({ IYZICO_API_KEY: API_KEY, IYZICO_SECRET_KEY: SECRET }).baseUrl, 'https://sandbox-api.iyzipay.com', 'sandbox by default');
  assert.equal(iyzicoFromEnv({ IYZICO_API_KEY: API_KEY, IYZICO_SECRET_KEY: SECRET, IYZICO_BASE_URL: 'live' }).baseUrl, 'https://api.iyzipay.com');
});

test('credential test calls a signed endpoint and reports rejection without echoing keys', async () => {
  const good = client(({ path }) => (path === '/payment/bin/check' ? { status: 'success' } : {}));
  assert.deepEqual(await good.iyzico.testCredentials(), { ok: true });
  assert.equal(good.requests[0].signed, true);
  assert.equal(good.requests[0].url, 'https://sandbox-api.iyzipay.com/payment/bin/check');
  assert.equal(good.requests[0].headers['x-iyzi-rnd'], '1700000000000123456');
  const bad = client(() => ({ status: 'failure', errorCode: '1000', errorMessage: 'Invalid API key' }));
  const result = await bad.iyzico.testCredentials();
  assert.equal(result.ok, false);
  assert.equal(result.message, 'Invalid API key');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  const down = createIyzico({ apiKey: API_KEY, secretKey: SECRET, fetcher: async () => { throw new Error('boom ' + SECRET); } });
  await assert.rejects(() => down.testCredentials(), (e) => e.status === 502 && !e.message.includes(SECRET));
});

test('checkout initialize sends KDV-inclusive kuruş as decimals and verifies the response signature', async () => {
  const { iyzico, requests } = client(({ body }) => ({
    status: 'success', conversationId: body.conversationId, token: 'tok-1', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok-1',
    signature: hmac(`${body.conversationId}:tok-1`),
  }));
  const result = await iyzico.initializeCheckout({
    conversationId: 'pay-1', amountKurus: 125050, basketId: 'pay-1', description: 'Han Hukuk abonelik', callbackUrl: 'https://admin.han.example/api/platform/pay/callback', buyer, ip: '203.0.113.5',
  });
  assert.deepEqual(result, { token: 'tok-1', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok-1' });
  const sent = requests[0];
  assert.equal(sent.path, '/payment/iyzipos/checkoutform/initialize/auth/ecom');
  assert.equal(sent.signed, true);
  assert.equal(sent.body.price, '1250.50');
  assert.equal(sent.body.paidPrice, '1250.50');
  assert.equal(sent.body.currency, 'TRY');
  assert.equal(sent.body.basketItems[0].price, '1250.50', 'basket total equals the price');
  assert.equal(sent.body.buyer.identityNumber, '11111111111', 'placeholder only when none is given');
  assert.equal(sent.body.buyer.ip, '203.0.113.5');
  assert.equal(sent.body.callbackUrl, 'https://admin.han.example/api/platform/pay/callback');
  await assert.rejects(() => iyzico.initializeCheckout({ conversationId: 'p', amountKurus: 0, basketId: 'p', description: 'x', callbackUrl: 'https://a.example/', buyer }), (e) => e.status === 400);
});

test('checkout initialize rejects a forged signature, a foreign payment URL and provider errors', async () => {
  const input = { conversationId: 'pay-1', amountKurus: 1000, basketId: 'pay-1', description: 'x', callbackUrl: 'https://a.example/cb', buyer };
  const forged = client(() => ({ status: 'success', conversationId: 'pay-1', token: 'tok', paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok', signature: 'f'.repeat(64) }));
  await assert.rejects(() => forged.iyzico.initializeCheckout(input), (e) => e.status === 502 && /doğrulanamadı/.test(e.message));
  const foreign = client(({ body }) => ({ status: 'success', conversationId: body.conversationId, token: 'tok', paymentPageUrl: 'https://evil.example/pay', signature: hmac(`${body.conversationId}:tok`) }));
  await assert.rejects(() => foreign.iyzico.initializeCheckout(input), (e) => e.status === 502);
  const rejected = client(() => ({ status: 'failure', errorCode: '11', errorMessage: 'Geçersiz adres' }));
  await assert.rejects(() => rejected.iyzico.initializeCheckout(input), (e) => e.status === 502 && /Geçersiz adres/.test(e.message));
});

test('checkout retrieve verifies the documented signature fields and returns exact kuruş', async () => {
  const payment = (extra = {}) => {
    const base = { status: 'success', paymentStatus: 'SUCCESS', paymentId: '555', currency: 'TRY', basketId: 'pay-1', conversationId: 'pay-1', paidPrice: '1250.50', price: '1250.5', token: 'tok-1', ...extra };
    base.signature = extra.signature ?? hmac(['SUCCESS', '555', 'TRY', 'pay-1', 'pay-1', '1250.5', '1250.5', 'tok-1'].join(':'));
    return base;
  };
  const ok = client(() => payment());
  const result = await ok.iyzico.retrieveCheckout('tok-1', 'pay-1');
  assert.deepEqual(result, { paid: true, paymentStatus: 'SUCCESS', paymentId: '555', conversationId: 'pay-1', basketId: 'pay-1', currency: 'TRY', priceKurus: 125050, paidKurus: 125050 });
  assert.equal(ok.requests[0].path, '/payment/iyzipos/checkoutform/auth/ecom/detail');
  assert.equal(ok.requests[0].signed, true);
  assert.deepEqual(ok.requests[0].body, { locale: 'tr', conversationId: 'pay-1', token: 'tok-1' });

  // A tampered amount or status no longer matches the signature.
  for (const tamper of [{ paidPrice: '1.00' }, { paymentStatus: 'FAILURE' }, { basketId: 'other' }, { signature: 'a'.repeat(64) }, { signature: '' }]) {
    const forged = client(() => payment(tamper));
    await assert.rejects(() => forged.iyzico.retrieveCheckout('tok-1', 'pay-1'), (e) => e.status === 502 && /doğrulanamadı/.test(e.message), JSON.stringify(tamper));
  }
  const failed = client(() => {
    const d = { status: 'success', paymentStatus: 'FAILURE', paymentId: '', currency: 'TRY', basketId: 'pay-1', conversationId: 'pay-1', paidPrice: '1250.50', price: '1250.50', token: 'tok-1' };
    return { ...d, signature: hmac(['FAILURE', '', 'TRY', 'pay-1', 'pay-1', '1250.5', '1250.5', 'tok-1'].join(':')) };
  });
  assert.equal((await failed.iyzico.retrieveCheckout('tok-1', 'pay-1')).paid, false);
});

test('payment link carries the amount as decimals and returns only an iyzico URL', async () => {
  const { iyzico, requests } = client(() => ({ status: 'success', data: { token: 'lnk-1', url: 'https://iyzi.link/ABC123' } }));
  assert.deepEqual(await iyzico.createPaymentLink({ name: 'Danışmanlık', description: 'Kasım danışmanlık ücreti', amountKurus: 250000, conversationId: 'c1' }), { url: 'https://iyzi.link/ABC123', token: 'lnk-1' });
  assert.equal(requests[0].path, '/v2/iyzilink/products');
  assert.equal(requests[0].signed, true);
  assert.equal(requests[0].body.price, '2500.00');
  assert.equal(requests[0].body.currencyCode, 'TRY');
  assert.ok(requests[0].body.encodedImageFile.length > 20);
  await assert.rejects(() => iyzico.createPaymentLink({ name: 'x', description: 'x', amountKurus: 99 }), (e) => e.status === 400);
  const foreign = client(() => ({ status: 'success', data: { token: 't', url: 'https://evil.example/ABC' } }));
  await assert.rejects(() => foreign.iyzico.createPaymentLink({ name: 'x', description: 'x', amountKurus: 1000 }), (e) => e.status === 502);
  const rejected = client(() => ({ status: 'failure', errorMessage: 'Link izni yok' }));
  await assert.rejects(() => rejected.iyzico.createPaymentLink({ name: 'x', description: 'x', amountKurus: 1000 }), (e) => /Link izni yok/.test(e.message));
});

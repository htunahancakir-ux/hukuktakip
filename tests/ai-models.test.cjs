const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { JSDOM } = require('jsdom');
const aiSettings = require('../lib/ai-settings.cjs');
const { handleAiRoutes } = require('../outputs/icrapro/access-ai.cjs');
const { limits } = require('../lib/rate-policy.cjs');
const { scopeFor } = require('../lib/ceo-pin.cjs');

const ADDRESS = 'https://evren-llmapi.ssyz.org.tr/v1';
const input = (extra = {}) => ({ provider: 'custom:new', baseUrl: ADDRESS, apiKey: '', ...extra });
const listing = (data) => new Response(JSON.stringify({ object: 'list', data }));

// Saving a provider needs the credential key; the saved config carries one sealed API key.
async function withSavedProvider(run) {
  const original = process.env.AI_ENCRYPTION_KEY;
  process.env.AI_ENCRYPTION_KEY = 'a'.repeat(64);
  try {
    const saved = aiSettings.configure(
      {},
      {
        enabled: true,
        provider: 'custom:new',
        providerName: 'Evren',
        baseUrl: ADDRESS,
        apiFormat: 'chat-completions',
        model: 'evren-model',
        reasoningEffort: 'none',
        summaryMaxChars: 300,
        apiKey: 'saved-secret-key',
      },
    );
    return await run(saved);
  } finally {
    if (original === undefined) delete process.env.AI_ENCRYPTION_KEY;
    else process.env.AI_ENCRYPTION_KEY = original;
  }
}

test("lists a custom provider's models: sorted, sanitized, the typed key used once and never returned", async () => {
  let seen;
  const result = await aiSettings.listModels({}, input({ baseUrl: ADDRESS + '/', apiKey: ' typed-key ' }), {
    fetcher: async (url, options) => {
      seen = { url, options };
      return listing([
        { id: 'zeta-model' },
        { id: 'Alpha-1' },
        { id: 'beta' },
        { id: 'beta' },
        { id: '<script>alert(1)</script>' },
        { id: 'x'.repeat(200) },
        { id: '' },
        null,
        7,
        'plain-id',
        { name: 'by-name' },
        { model: 'by-model' },
      ]);
    },
  });
  assert.equal(seen.url, ADDRESS + '/models');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.redirect, 'error', 'a redirect could carry the key elsewhere');
  assert.equal(seen.options.headers.Authorization, 'Bearer typed-key');
  assert(seen.options.signal instanceof AbortSignal);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['Alpha-1', 'beta', 'by-model', 'by-name', 'plain-id', 'zeta-model'],
  );
  assert.equal(result.total, 6);
  assert.equal(result.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /typed-key/);
});

test('a provider that lists models without a key is asked without one', async () => {
  let headers;
  await aiSettings.listModels({}, input(), {
    fetcher: async (_url, options) => {
      headers = options.headers;
      return listing([{ id: 'open-model' }]);
    },
  });
  assert.equal(headers.Authorization, undefined);
});

test('a saved key travels only to the address it was saved for; a half-typed address never falls back', async () => {
  await withSavedProvider(async (saved) => {
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return listing([{ id: 'm' }]);
    };
    const ask = (extra) =>
      aiSettings.listModels(saved, { provider: saved.provider, apiKey: '', ...extra }, { fetcher });
    await ask({ baseUrl: ADDRESS }); // key left empty: the saved key
    await ask({ baseUrl: '' }); // nothing typed: the saved address and key
    await ask({ baseUrl: ADDRESS + '/' }); // the same address
    await ask({ baseUrl: 'https://baska.example.com/v1' }); // another address: the saved key stays home
    await ask({ baseUrl: 'https://baska.example.com/v1', apiKey: 'typed-key' }); // a typed key goes where typed
    assert.deepEqual(
      calls.map((call) => call.authorization),
      [
        'Bearer saved-secret-key',
        'Bearer saved-secret-key',
        'Bearer saved-secret-key',
        undefined,
        'Bearer typed-key',
      ],
    );
    assert.equal(calls[3].url, 'https://baska.example.com/v1/models');
    const before = calls.length;
    for (const baseUrl of [
      'https://evren',
      'http://evren-llmapi.ssyz.org.tr/v1',
      'https://127.0.0.1/v1',
      'https://localhost/v1',
      'https://user:pw@evren-llmapi.ssyz.org.tr/v1',
      'https://evren-llmapi.ssyz.org.tr:8443/v1',
      ADDRESS + '?x=1',
      'not a url',
    ])
      await assert.rejects(
        ask({ baseUrl }),
        (error) => error.code === 400 && /Base URL/.test(error.message),
        baseUrl,
      );
    assert.equal(calls.length, before, 'nothing is sent for an unusable address');
  });
});

test('provider failures become readable messages and never look like an expired session', async () => {
  const status = (code) => async () => new Response('{}', { status: code });
  const expectError = (extra, fetcher, pattern) =>
    assert.rejects(
      aiSettings.listModels({}, input(extra), { fetcher }),
      (error) => error.code === 502 && pattern.test(error.message),
    );
  await expectError({}, status(401), /API anahtarını girin/);
  await expectError({ apiKey: 'k' }, status(401), /anahtarını kabul etmedi/);
  await expectError({ apiKey: 'k' }, status(403), /anahtarını kabul etmedi/);
  await expectError({}, status(404), /\/models/);
  await expectError({}, status(429), /hız sınırı/);
  await expectError({}, status(503), /geçici olarak/);
  await expectError({}, status(418), /HTTP 418/);
  await expectError(
    {},
    async () => {
      throw new Error('ENOTFOUND');
    },
    /bağlanılamadı/,
  );
  await expectError({}, async () => new Response('<html>', { status: 200 }), /anlaşılır bir model listesi/);
  await expectError({}, async () => new Response(JSON.stringify({ foo: 1 })), /anlaşılır bir model listesi/);
  const tooLarge = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600 * 1024));
          controller.enqueue(new Uint8Array(600 * 1024));
          controller.close();
        },
      }),
    );
  await expectError({}, tooLarge, /anlaşılır bir model listesi/);
});

test('accepts the common list shapes and caps a very long list', async () => {
  const ids = async (answer) =>
    (await aiSettings.listModels({}, input(), { fetcher: async () => answer })).models.map((m) => m.id);
  assert.deepEqual(await ids(listing([{ id: 'a1' }])), ['a1']);
  assert.deepEqual(await ids(new Response(JSON.stringify({ models: [{ id: 'b1' }, 'b0'] }))), ['b0', 'b1']);
  assert.deepEqual(await ids(new Response(JSON.stringify(['c1', { id: 'c0' }]))), ['c0', 'c1']);
  assert.deepEqual(await ids({ ok: true, json: async () => ({ data: [{ id: 'd1' }] }) }), ['d1']);
  assert.deepEqual(await ids(listing([])), []);
  const long = await aiSettings.listModels({}, input(), {
    fetcher: async () =>
      listing(Array.from({ length: 600 }, (_, i) => ({ id: 'model-' + String(i).padStart(3, '0') }))),
  });
  assert.equal(long.models.length, 500);
  assert.equal(long.total, 600);
  assert.equal(long.truncated, true);
  assert.equal(long.models[499].id, 'model-499');
});

test('only custom providers are listed, with a usable selection and a clean key', async () => {
  const fetcher = async () => {
    throw new Error('must not be called');
  };
  for (const [extra, pattern] of [
    [{ provider: 'openai' }, /özel sağlayıcılar/],
    [{ provider: 'vercel-ai-gateway' }, /özel sağlayıcılar/],
    [{ provider: 'custom:cp_000000000000000000000000' }, /bulunamadı/],
    [{ apiKey: 'bad\nkey' }, /biçimi geçersiz/],
    [{ apiKey: 'k'.repeat(513) }, /biçimi geçersiz/],
    [{ apiKey: 5 }, /biçimi geçersiz/],
  ])
    await assert.rejects(
      aiSettings.listModels({}, input(extra), { fetcher }),
      (error) => error.code === 400 && pattern.test(error.message),
      JSON.stringify(extra),
    );
});

test('the model list route is CEO-only, POST-only, saves nothing and reports provider errors as 502', async () => {
  const run = async (user, method, body) => {
    const sent = [];
    const ctx = {
      url: new URL('https://app.test/api/ai/models'),
      req: { method },
      res: {},
      u: user,
      state: { aiConfig: {} },
      fail: (code, message) => Object.assign(new Error(message), { code }),
      body: async () => body,
      send: (_res, status, payload) => sent.push([status, payload]),
      persist: () => {
        throw new Error('the model list must not be saved');
      },
    };
    return { handled: await handleAiRoutes(ctx), sent };
  };
  const originalFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return listing([{ id: 'b' }, { id: 'a' }]);
    };
    await assert.rejects(run({ id: 'u', role: 'staff' }, 'POST', input()), (error) => error.code === 403);
    await assert.rejects(run({ id: 'u', role: 'admin' }, 'POST', input()), (error) => error.code === 403);
    await assert.rejects(run({ id: 'u', role: 'ceo' }, 'GET', input()), (error) => error.code === 405);
    assert.equal(requests, 0);
    const { handled, sent } = await run({ id: 'u', role: 'ceo' }, 'POST', input({ apiKey: 'typed-key' }));
    assert.equal(handled, true);
    assert.deepEqual(sent, [
      [200, { ok: true, models: [{ id: 'a' }, { id: 'b' }], total: 2, truncated: false }],
    ]);
    assert.doesNotMatch(JSON.stringify(sent), /typed-key/);
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(
      run({ id: 'u', role: 'ceo' }, 'POST', input({ apiKey: 'k' })),
      (error) => error.code === 502,
      "a provider's 401 must not log the CEO out",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(limits['/api/ai/models'], ['ai-models', 60]);
  assert.equal(scopeFor(new URL('https://app.test/api/ai/models'), 'POST'), 'integrations');
});

// The settings page with its helpers stubbed; timers fire at once but the requested delays are kept.
async function aiPage({ saved = {}, fetchImpl }) {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  const requests = [];
  const delays = [];
  const config = aiSettings.publicConfig(saved);
  Object.assign(w, {
    hanAuth: { role: 'ceo' },
    $: (selector) => w.document.querySelector(selector),
    esc: (value) =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    toast: () => {},
    settingsSectionTabs: () => '',
    bindSettingsSectionTabs: () => {},
    authApi: (url) => {
      if (url === '/api/ai/config') return config;
      throw new Error('unexpected request ' + url);
    },
    setTimeout: (callback, ms) => {
      delays.push(ms);
      return setTimeout(callback, 0);
    },
    clearTimeout,
    fetch: (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, options });
      return fetchImpl(body, options);
    },
  });
  w.eval(await fs.readFile('outputs/icrapro/workspace-ai.js', 'utf8'));
  w.aiSettingsPage();
  const form = w.document.querySelector('#aiConfigForm');
  const type = (name, value) => {
    form.elements[name].value = value;
    form.elements[name].dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const choose = (value) => {
    form.elements.provider.value = value;
    form.elements.provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const options = () => [...w.document.querySelectorAll('#aiModelList option')].map((o) => o.value);
  const status = () => w.document.querySelector('#aiModelStatus').textContent;
  return { dom, w, form, requests, delays, type, choose, settle, options, status };
}
const modelAnswer = (models) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    models: models.map((id) => ({ id })),
    total: models.length,
    truncated: false,
  }),
});

test("typing the address and the key lists the provider's models in the model field", async () => {
  const page = await aiPage({
    fetchImpl: async (body) =>
      body.apiKey
        ? modelAnswer(['evren-small', 'evren-large'])
        : {
            ok: false,
            status: 502,
            json: async () => ({
              error: 'Sağlayıcı model listesi için API anahtarı istiyor. API anahtarını girin.',
            }),
          },
  });
  try {
    const { form, requests, delays, type, choose, settle, options, status } = page;
    // Nothing is asked while the page is merely open.
    await settle();
    assert.equal(requests.length, 0);
    // A new provider; an address that is still being typed asks nothing.
    choose('custom:new');
    type('baseUrl', 'https://evren');
    await settle();
    assert.equal(requests.length, 0);
    assert.match(status(), /tam model kimliğini girin/);
    // The finished address is asked once typing stops; this provider wants a key.
    type('baseUrl', ADDRESS);
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/ai/models');
    assert.deepEqual(requests[0].body, { provider: 'custom:new', baseUrl: ADDRESS, apiKey: '' });
    assert.equal(requests[0].options.headers['X-Han-Request'], '1');
    assert.match(status(), /API anahtarını girin\. Model adını elle de yazabilirsiniz\./);
    assert.deepEqual(options(), []);
    // The key completes the request.
    type('apiKey', 'typed-key');
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.apiKey, 'typed-key');
    assert.deepEqual(options(), ['evren-small', 'evren-large']);
    assert.match(status(), /2 model bulundu/);
    assert(delays.includes(800), 'the page waits for typing to stop');
    // The model field offers the list, and a name that is not listed is still accepted.
    assert.equal(form.elements.model.getAttribute('list'), 'aiModelList');
    assert.equal(form.elements.transcriptionModel.getAttribute('list'), 'aiModelList');
    form.elements.model.value = 'my-own-model';
    assert.equal(form.elements.model.validity.valid, true);
  } finally {
    page.dom.window.close();
  }
});

test('a slower, older answer never replaces a newer model list, and the button is free again afterwards', async () => {
  const pending = [];
  const page = await aiPage({
    fetchImpl: (body) => new Promise((resolve) => pending.push({ body, resolve })),
  });
  try {
    const { w, requests, type, choose, settle, options } = page;
    choose('custom:new');
    type('baseUrl', 'https://one.example.com/v1');
    await settle();
    type('baseUrl', 'https://two.example.com/v1');
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(w.document.querySelector('#aiLoadModels').disabled, true, 'busy while asking');
    pending[1].resolve(modelAnswer(['two-model']));
    await settle();
    pending[0].resolve(modelAnswer(['one-model'])); // the older answer arrives last
    await settle();
    assert.deepEqual(options(), ['two-model']);
    assert.equal(w.document.querySelector('#aiLoadModels').disabled, false);
  } finally {
    page.dom.window.close();
  }
});

test('a saved provider lists its models when the page opens; names are inserted as text; the button explains a missing address', async () => {
  await withSavedProvider(async (saved) => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const page = await aiPage({ saved, fetchImpl: async () => modelAnswer([hostile, 'ok-model']) });
    try {
      const { w, form, requests, choose, settle, options, status } = page;
      await settle();
      // The saved provider is asked once, without typing: its saved address, no key in the page.
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].body, { provider: saved.provider, baseUrl: ADDRESS, apiKey: '' });
      assert.deepEqual(options(), [hostile, 'ok-model']);
      assert.equal(w.document.querySelectorAll('img').length, 0);
      // The button with an emptied address says what is missing and asks nothing.
      form.elements.baseUrl.value = '';
      w.document.querySelector('#aiLoadModels').click();
      await settle();
      assert.equal(requests.length, 1);
      assert.match(status(), /Önce geçerli bir HTTPS Base URL girin/);
      assert.deepEqual(options(), []);
      // Built-in providers keep their own fixed lists: nothing is asked for them.
      choose('openai');
      await settle();
      assert.equal(requests.length, 1);
    } finally {
      page.dom.window.close();
    }
  });
});

test("a provider's 401 in the connection test is reported as 502; other statuses are kept", async () => {
  const body = {
    enabled: true,
    provider: 'custom:new',
    providerName: 'Evren',
    baseUrl: ADDRESS,
    apiFormat: 'chat-completions',
    model: 'evren-model',
    summaryMaxChars: 300,
    apiKey: 'typed-key',
  };
  const status = (code) => async () => new Response('{}', { status: code });
  // Our own 401 reloads the page as an expired session, so a wrong key must not look like one.
  for (const [code, expected] of [
    [401, 502],
    [403, 403],
    [404, 404],
    [429, 429],
    [503, 503],
  ])
    await assert.rejects(
      aiSettings.testConnection({}, body, { fetcher: status(code) }),
      (error) => error.code === expected,
      String(code),
    );
  await assert.rejects(
    aiSettings.testConnection({}, body, { fetcher: status(401) }),
    /API anahtarı kabul edilmedi/,
  );
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { JSDOM } = require('jsdom');
const { keepErrorsPastProxy } = require('../lib/proxy-safe-status.cjs');

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, keepErrorsPastProxy(res)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('502 and 504 leave our server as 424 with the same JSON message', async () => {
  const body = JSON.stringify({ error: 'Verimor yanıtı alınamadı. Arama başladıysa tekrar başlatmayın.' });
  const server = await serve((req, res) => {
    const status = Number(req.url.slice(1));
    if (req.url === '/implicit') {
      // Same path as lib/saas/tenant-router.cjs: statusCode, then end.
      res.statusCode = 504;
      return res.end(body);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  });
  try {
    for (const [path, expected] of [
      ['/502', 424],
      ['/504', 424],
      ['/implicit', 424],
      ['/503', 503],
      ['/500', 500],
      ['/409', 409],
      ['/200', 200],
    ]) {
      const response = await fetch(server.url + path);
      assert.equal(response.status, expected, path);
      assert.equal((await response.json()).error, JSON.parse(body).error, path);
    }
  } finally {
    await server.close();
  }
});

async function voipWindow(answer) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only',
    url: 'https://x.test/',
  });
  const w = dom.window;
  w.esc = (value) => String(value ?? '');
  w.fetch = async () => answer;
  w.eval(await fs.readFile('outputs/icrapro/workspace-voip.js', 'utf8'));
  return dom;
}
const page = '<!DOCTYPE html><html><head><title>504 Gateway time-out</title></head></html>';

test('a proxy error page on a call start says the call may already be ringing', async () => {
  const dom = await voipWindow({ ok: false, status: 504, json: async () => JSON.parse(page) });
  try {
    await assert.rejects(dom.window.voipApi('start', 'POST', { phone: '905320000000' }), (error) => {
      assert.match(error.message, /^Sunucudan yanıt alınamadı \(HTTP 504\)\. Arama başlamış olabilir/);
      assert.doesNotMatch(error.message, /Unexpected token|JSON/);
      assert.equal(error.status, 504);
      return true;
    });
    await assert.rejects(
      dom.window.voipApi('calls?phone=905320000000'),
      /Birkaç saniye sonra tekrar deneyin/,
    );
  } finally {
    dom.window.close();
  }
});

test('the server message of an outside-service error reaches the screen unchanged', async () => {
  const message =
    'Verimor yanıtı alınamadı. Arama başladıysa tekrar başlatmayın; çağrı durumunu kontrol edin.';
  const dom = await voipWindow({
    ok: false,
    status: 424,
    json: async () => ({ error: message }),
  });
  try {
    await assert.rejects(dom.window.voipApi('start', 'POST', {}), (error) => error.message === message);
  } finally {
    dom.window.close();
  }
});

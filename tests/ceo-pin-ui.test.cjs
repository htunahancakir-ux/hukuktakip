const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
test('PIN sonrası fetch yeniden denemesi oturum çerezini kullanır', async () => {
  const dom = new JSDOM('', { url: 'https://example.test', runScripts: 'dangerously' });
  try {
    const w = dom.window;
    let calls = 0;
    w.Headers = Headers;
    w.hanAuth = { role: 'ceo' };
    w.authApi = () => ({ configured: true, scopes: ['delete'], unlocked: true });
    w.fetch = async (url, options) => {
      assert.equal(options.headers.has('X-Han-Pin-Proof'), false);
      return ++calls === 1
        ? new Response(JSON.stringify({ code: 'CEO_PIN_REQUIRED' }), { status: 423 })
        : new Response('{}');
    };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-ceo-pin.js', 'utf8'));
    assert.equal((await w.fetch('/api/operations/delete')).status, 200);
    assert.equal(calls, 2);
  } finally {
    dom.window.close();
  }
});
test('PIN penceresi kompakttır; açık tarayıcı oturumunda tekrar sorulmaz', async () => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  try {
    const w = dom.window;
    let unlocked = false;
    w.page = 'settings';
    w.settingsTab = 'permissions';
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new w.Event('close'));
    };
    w.hanAuth = { role: 'ceo' };
    w.authApi = (path, method, values) =>
      path.endsWith('/status')
        ? { configured: true, scopes: ['permissions'], unlocked }
        : values.pin === '2580'
          ? ((unlocked = true), { ok: true, proof: 'test-proof' })
          : { ok: false, error: 'PIN hatalı.' };
    w.eval(fs.readFileSync('outputs/icrapro/workspace-ceo-pin.js', 'utf8'));
    const unlock = w.requireCeoPin('permissions');
    const input = w.document.querySelector('input');
    assert.equal(input.type, 'password');
    input.value = '0000';
    w.document.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(w.hanPinProofs.permissions, undefined);
    input.value = '2580';
    w.document.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(await unlock, true);
    assert.equal(w.localStorage.length, 0);
    assert.equal(await w.requireCeoPin('permissions'), true);
    assert.equal(w.document.querySelector('dialog'), null);
    unlocked = false;
    const again = w.requireCeoPin('permissions');
    assert.ok(w.document.querySelector('dialog'));
    assert.equal(w.document.querySelector('dialog').style.maxWidth, '340px');
    w.document.querySelector('button[type="button"]').click();
    assert.equal(await again, false);
  } finally {
    dom.window.close();
  }
});

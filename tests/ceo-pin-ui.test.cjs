const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
test('PIN alanı maskelenir, hatalı PIN kabul edilmez ve kanıt yalnız bellekte tutulur', async () => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://example.test',
    runScripts: 'dangerously',
  });
  try {
    const w = dom.window;
    let expire;
    w.setTimeout = (callback) => {
      expire = callback;
    };
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
        ? { configured: true, scopes: ['permissions'] }
        : values.pin === '2580'
          ? { ok: true, proof: 'test-proof' }
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
    assert.equal(w.hanPinProofs.permissions, 'test-proof');
    assert.equal(w.localStorage.length, 0);
    w.document.getElementById('content').textContent = 'Protected permissions';
    expire();
    assert.equal(w.hanPinProofs.permissions, undefined);
    assert.match(w.document.getElementById('content').textContent, /süresi doldu/);
  } finally {
    dom.window.close();
  }
});

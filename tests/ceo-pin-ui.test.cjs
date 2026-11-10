const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
test('CEO opens protected areas without a PIN dialog or proof header', async (t) => {
  const dom = new JSDOM('', { url: 'https://example.test', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.Headers = Headers;
  w.hanAuth = { role: 'ceo' };
  w.authApi = () => {
    throw Error('CEO must not be prompted for a PIN');
  };
  let calls = 0;
  w.fetch = async (url, options) => {
    calls++;
    assert.equal(options.headers.has('X-Han-Pin-Proof'), false);
    return new Response('{}');
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-ceo-pin.js', 'utf8'));
  for (const scope of ['permissions', 'delete', 'integrations'])
    assert.equal(await w.requireCeoPin(scope), true);
  for (const url of ['/api/users', '/api/operations/delete', '/api/voip/config']) {
    assert.equal(w.ceoPinScope(url), null);
    assert.equal((await w.fetch(url)).status, 200);
  }
  assert.equal(calls, 3);
  assert.equal(w.document.querySelector('dialog'), null);
});

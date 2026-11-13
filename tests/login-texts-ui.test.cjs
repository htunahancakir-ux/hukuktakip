const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// Loads the login screen's drawing code (and the settings editor) as classic scripts, so their
// top-level constants are shared the way the browser shares them.
function setup(replies, files = ['login-layout.js']) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://buro.example.test/',
    runScripts: 'dangerously',
  });
  const w = dom.window;
  const requests = [];
  const toasts = [];
  w.structuredClone = structuredClone;
  w.assetUrl = (file) => file;
  w.toast = (message) => toasts.push(message);
  w.confirm = () => true;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  w.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method: options.method || 'GET', body });
    const reply = replies[`${options.method || 'GET'} ${url}`];
    if (!reply) throw new TypeError('offline');
    const [status, json] = reply(body);
    return { ok: status < 400, status, json: async () => json };
  };
  for (const file of files) {
    const script = w.document.createElement('script');
    script.textContent = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
    w.document.body.append(script);
  }
  return { w, requests, toasts };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const key = (w, el, name, extra = {}) =>
  el.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));

test('a login text is drawn as plain text at its place and size; the brand gets the logo and a gold last word', () => {
  const { w } = setup({});
  const hostile = w.loginTextElement({
    id: 'x',
    text: '<img src=x onerror="window.pwned=1">',
    style: 'text',
    color: 'gold',
    bold: true,
    x: 20,
    y: 30,
    size: 2.5,
  });
  assert.equal(hostile.querySelector('img'), null);
  assert.equal(hostile.textContent, '<img src=x onerror="window.pwned=1">');
  assert.equal(hostile.style.left, '20%');
  assert.equal(hostile.style.top, '30%');
  assert.equal(hostile.style.fontSize, '2.5cqw');
  assert.deepEqual(
    [...hostile.classList],
    ['login-text', 'login-text--text', 'login-text--gold', 'login-text--bold'],
  );

  const brand = w.loginTextElement({
    id: 'marka',
    text: 'Örnek  Hukuk Bürosu',
    style: 'brand',
    color: 'white',
    bold: true,
    x: 15,
    y: 6.9,
    size: 4,
  });
  assert.equal(brand.querySelector('img.login-text-mark').getAttribute('src'), 'brand-scales.png');
  assert.equal(brand.querySelector('strong').textContent, 'Örnek Hukuk Bürosu');
  assert.equal(brand.querySelector('strong span').textContent, 'Bürosu');

  // Restyling keeps classes that are not the text's own (the editor's selection marks).
  brand.classList.add('lte-item', 'is-selected');
  w.placeLoginText(brand, {
    id: 'marka',
    text: 'x',
    style: 'label',
    color: 'soft',
    bold: false,
    x: 1,
    y: 2,
    size: 3,
  });
  assert.deepEqual([...brand.classList].sort(), [
    'is-selected',
    'login-text',
    'login-text--label',
    'login-text--soft',
    'lte-item',
  ]);
});

function story(w) {
  const el = w.document.createElement('section');
  el.className = 'login-story';
  el.innerHTML = '<div class="login-brand"></div><div class="login-story-copy"></div>';
  w.document.body.append(el);
  return el;
}

test('the login screen shows the office texts in place of the built-in ones, without a flash', async () => {
  const texts = [
    { id: 'a', text: 'Bizim Büro', style: 'brand', color: 'white', bold: true, x: 10, y: 10, size: 4 },
    { id: 'b', text: 'Size özel', style: 'heading', color: 'gold', bold: false, x: 10, y: 70, size: 6 },
  ];
  const { w, requests } = setup({ 'GET /api/login-texts': () => [200, { texts }] });
  const panel = story(w);
  w.placeLoginTexts(panel);
  assert.ok(panel.classList.contains('login-story--pending'), 'built-in texts are held back while asking');
  await settle();
  assert.ok(panel.classList.contains('login-story--custom'));
  assert.ok(!panel.classList.contains('login-story--pending'));
  assert.deepEqual(
    [...panel.querySelectorAll('.login-texts .login-text')].map((el) => el.textContent),
    ['Bizim Büro', 'Size özel'],
  );
  assert.equal(requests.length, 1);
});

test('without office texts, or when they cannot be read, the built-in texts stay', async () => {
  for (const replies of [{ 'GET /api/login-texts': () => [200, { texts: null }] }, {}]) {
    const { w } = setup(replies);
    const panel = story(w);
    w.placeLoginTexts(panel);
    await settle();
    assert.ok(!panel.classList.contains('login-story--custom'));
    assert.ok(!panel.classList.contains('login-story--pending'));
    assert.equal(panel.querySelector('.login-texts'), null);
  }
});

test('the editor moves, resizes, edits, adds and deletes texts and saves them together', async () => {
  const { w, requests, toasts } = setup({ 'PUT /api/login-texts': (body) => [200, { texts: body.texts }] }, [
    'login-layout.js',
    'workspace-login-texts.js',
  ]);
  let saved;
  w.openLoginTextsEditor({ saved: null, artVersion: null, onSaved: (texts) => (saved = texts) });
  const dialog = w.document.getElementById('loginTextsDialog');
  const items = () => [...dialog.querySelectorAll('.lte-item')];
  assert.deepEqual(
    items().map((el) => el.dataset.textId),
    ['marka', 'alt-baslik', 'baslik', 'aciklama', 'alan-adi'],
    'starts from the built-in texts',
  );
  assert.equal(dialog.querySelector('.lte-props').disabled, true);

  const heading = () => items().find((el) => el.dataset.textId === 'baslik');
  key(w, heading(), 'Enter');
  assert.equal(dialog.querySelector('.lte-props').disabled, false);
  assert.equal(dialog.querySelector('[data-lte="text"]').value, 'Her dosyada özen.');
  assert.ok(heading().querySelector('.lte-handle'), 'the selected text has a resize handle');

  key(w, heading(), 'ArrowRight');
  key(w, heading(), 'ArrowUp', { shiftKey: true });
  key(w, heading(), '+');
  assert.equal(heading().style.left, '15.5%');
  assert.equal(heading().style.top, '79.5%');
  assert.equal(heading().style.fontSize, '5.8cqw');

  const text = dialog.querySelector('[data-lte="text"]');
  text.value = 'Güvenle tahsilat.';
  text.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(heading().textContent, 'Güvenle tahsilat.');
  const color = dialog.querySelector('[data-lte="color"]');
  color.value = 'gold';
  color.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.ok(heading().classList.contains('login-text--gold'));

  dialog.querySelector('[data-lte-add]').click();
  assert.equal(items().length, 6);
  assert.equal(dialog.querySelector('[data-lte="text"]').value, 'Yeni yazı');
  dialog.querySelector('[data-lte-delete]').click();
  assert.equal(items().length, 5);

  // Deleting a built-in text with the keyboard.
  const domain = items().find((el) => el.dataset.textId === 'alan-adi');
  key(w, domain, 'Enter');
  key(
    w,
    items().find((el) => el.dataset.textId === 'alan-adi'),
    'Delete',
  );
  assert.equal(items().length, 4);

  dialog.querySelector('[data-lte-save]').click();
  await settle();
  const put = requests.find((r) => r.method === 'PUT');
  assert.deepEqual(
    put.body.texts.map((t) => t.id),
    ['marka', 'alt-baslik', 'baslik', 'aciklama'],
  );
  assert.deepEqual((({ text, color, x, y, size }) => ({ text, color, x, y, size }))(put.body.texts[2]), {
    text: 'Güvenle tahsilat.',
    color: 'gold',
    x: 15.5,
    y: 79.5,
    size: 5.8,
  });
  assert.deepEqual(saved, put.body.texts);
  assert.equal(w.document.getElementById('loginTextsDialog'), null, 'the window closes after saving');
  assert.ok(toasts.includes('Giriş ekranı yazıları kaydedildi.'));
});

test('closing the editor without saving keeps the changes for the next opening', async () => {
  const { w } = setup({}, ['login-layout.js', 'workspace-login-texts.js']);
  w.openLoginTextsEditor({ saved: null });
  let dialog = w.document.getElementById('loginTextsDialog');
  dialog.querySelector('[data-lte-add]').click();
  dialog.close();
  assert.equal(w.document.getElementById('loginTextsDialog'), null);

  w.openLoginTextsEditor({ saved: null });
  dialog = w.document.getElementById('loginTextsDialog');
  assert.equal(dialog.querySelectorAll('.lte-item').length, 6);
  assert.match(dialog.querySelector('.lte-hint').textContent, /geri yüklendi/);
});

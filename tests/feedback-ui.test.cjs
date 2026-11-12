const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('outputs/icrapro/workspace-feedback.js', 'utf8');
const SHOT = 'data:image/jpeg;base64,/9j/AA==';

function setup(t, { role = 'staff', shot = SHOT } = {}) {
  const dom = new JSDOM('<div class="header-actions"></div>', {
    url: 'https://example.test/#docs',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const requests = [];
  w.hanAuth = { role };
  w.esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  w.toast = (text) => (w.lastToast = text);
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method, body, headers: init.headers });
    const reply =
      url === '/api/feedback' && init.method === 'GET'
        ? { manager: role !== 'staff', items: [] }
        : { ok: true, item: {}, screenshotSaved: !!body?.screenshot };
    return { ok: true, json: async () => reply };
  };
  w.eval(source);
  w.captureFeedbackScreen = async () => shot;
  w.setupFeedbackButton();
  const dialog = () => w.document.getElementById('feedbackDialog');
  const open = async () => {
    w.document.querySelector('[data-feedback-open]').click();
    for (let i = 0; i < 5 && !dialog()?.open; i++) await new Promise((r) => setTimeout(r));
    return dialog();
  };
  const submit = async (form) => {
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r));
  };
  return { w, requests, open, submit };
}

test('the header button opens the window with kinds, recipient and the screenshot preview', async (t) => {
  const { w, open } = setup(t);
  assert.equal(w.document.querySelectorAll('[data-feedback-open]').length, 1);
  w.setupFeedbackButton();
  assert.equal(w.document.querySelectorAll('[data-feedback-open]').length, 1, 'Added once');
  const dialog = await open();
  assert.ok(dialog.open);
  const form = dialog.querySelector('[data-feedback-new]');
  assert.deepEqual(
    [...form.querySelectorAll('[name="kind"]')].map((i) => i.value),
    ['bug', 'suggestion', 'question'],
  );
  assert.equal(form.elements.target.value, 'support');
  assert.equal(form.querySelector('option[value="sales"]').disabled, true);
  assert.equal(dialog.querySelector('.feedback-shot').getAttribute('src'), SHOT);
  assert.equal(form.elements.withShot.checked, true);
  assert.equal(dialog.querySelector('[data-feedback-tab="list"]').textContent, 'Gönderdiklerim');
});

test('sending includes the screenshot only while "Ekran görüntüsünü ekle" is ticked', async (t) => {
  const { w, requests, open, submit } = setup(t);
  let dialog = await open();
  let form = dialog.querySelector('[data-feedback-new]');
  form.querySelector('[value="question"]').checked = true;
  form.elements.message.value = 'Rapor nerede?';
  await submit(form);
  const first = requests.find((r) => r.method === 'POST');
  assert.equal(first.url, '/api/feedback');
  assert.equal(first.headers['X-Han-Request'], '1');
  assert.equal(first.body.kind, 'question');
  assert.equal(first.body.target, 'support');
  assert.equal(first.body.page, '/#docs');
  assert.equal(first.body.screenshot, SHOT);
  assert.match(w.lastToast, /gönderildi/);

  dialog = await open();
  form = dialog.querySelector('[data-feedback-new]');
  form.elements.withShot.checked = false;
  form.elements.withShot.dispatchEvent(new w.Event('change'));
  assert.equal(dialog.querySelector('.feedback-shot').hidden, true);
  form.elements.message.value = 'Ekransız gönder';
  await submit(form);
  const second = requests.filter((r) => r.method === 'POST')[1];
  assert.equal(second.body.message, 'Ekransız gönder');
  assert.equal(second.body.screenshot, undefined);
});

test('without a screenshot the window says so; managers see "Gelen bildirimler"', async (t) => {
  const { open } = setup(t, { role: 'ceo', shot: null });
  const dialog = await open();
  assert.equal(dialog.querySelector('.feedback-shot'), null);
  assert.match(dialog.textContent, /Ekran görüntüsü alınamadı/);
  assert.equal(dialog.querySelector('[data-feedback-tab="list"]').textContent, 'Gelen bildirimler');
});

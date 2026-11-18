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
  // jsdom has no top layer: a window "shown modally" is marked so that :modal matches it.
  w.HTMLDialogElement.prototype.showModal = function () {
    this.shownModal = true;
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.shownModal = false;
    this.open = false;
  };
  const matches = w.Element.prototype.matches;
  w.HTMLDialogElement.prototype.matches = function (selector) {
    return selector === ':modal' ? !!(this.open && this.shownModal) : matches.call(this, selector);
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

// Everything outside a modal window is inert: a tab left in the page could be seen above an open
// window but not clicked, so a problem in a window could not be reported (2.7.4).
test('the Geri bildirim tab moves into the topmost open window and back, out of reach of window code', async (t) => {
  const { w } = setup(t);
  const doc = w.document;
  const tab = () => doc.querySelector('[data-feedback-open]');
  const settle = () => new Promise((r) => setTimeout(r));
  assert.equal(tab().parentNode, doc.body);
  assert.equal(tab().shadowRoot.querySelector('button').textContent, 'Geri bildirim');
  const first = doc.createElement('dialog');
  first.innerHTML = '<button>Kaydet</button>';
  const second = doc.createElement('dialog');
  doc.body.append(first, second);
  first.open = true; // dialog.show(): jsdom has no show()
  await settle();
  assert.equal(tab().parentNode, doc.body, 'A window that is not modal leaves the page clickable');
  first.close();
  first.showModal();
  await settle();
  assert.equal(tab().parentNode, first);
  // workspace-breaks.js disables, borrower-sheet.js removes every button of a window.
  first.querySelectorAll('button').forEach((b) => (b.disabled = true));
  assert.equal(first.querySelectorAll('button').length, 1, 'The tab button is not among them');
  assert.equal(tab().shadowRoot.querySelector('button').disabled, false);
  second.showModal();
  await settle();
  assert.equal(tab().parentNode, second, 'The window opened last is on top');
  second.close();
  await settle();
  assert.equal(tab().parentNode, first);
  first.innerHTML = '<p>Yeniden çizildi</p>';
  await settle();
  assert.equal(tab().parentNode, first, 'Put back after the window content is redrawn');
  first.close();
  await settle();
  assert.equal(tab().parentNode, doc.body);
  assert.equal(doc.querySelectorAll('[data-feedback-open]').length, 1);
});

test('the feedback window opens over a window and leaves the tab in it', async (t) => {
  const { w, open } = setup(t);
  const settle = () => new Promise((r) => setTimeout(r));
  const window = w.document.createElement('dialog');
  w.document.body.append(window);
  window.showModal();
  await settle();
  const dialog = await open();
  await settle();
  assert.ok(dialog.open);
  const tab = w.document.querySelector('[data-feedback-open]');
  assert.equal(tab.parentNode, window, 'The feedback window covers the tab instead of taking it');
  dialog.close();
  await settle();
  assert.equal(tab.parentNode, window);
});

test('the screenshot copy pins each open window where it is on screen, above its backdrop', (t) => {
  const { w } = setup(t);
  const copy = new JSDOM(
    '<main></main><dialog data-feedback-layer="0" style="margin-top: 40px"></dialog><dialog data-feedback-layer="1"></dialog>',
  ).window.document;
  w.pinFeedbackWindows(copy, [
    { rect: { left: 300, top: 120, width: 650, height: 400 }, backdrop: 'rgba(20, 36, 53, 0.467)' },
    { rect: { left: 500, top: 200, width: 300, height: 150 }, backdrop: 'rgba(0, 0, 0, 0)' },
  ]);
  const [lower, upper] = copy.querySelectorAll('dialog');
  const css = (el, property) => el.style.getPropertyValue(property);
  assert.deepEqual(
    ['position', 'left', 'top', 'width', 'height', 'margin-top', 'z-index'].map((p) => css(lower, p)),
    ['fixed', '300px', '120px', '650px', '400px', '0px', '2147483645'],
  );
  const shade = lower.previousElementSibling;
  assert.equal(shade.localName, 'div');
  assert.equal(css(shade, 'z-index'), '2147483644');
  assert.equal(css(shade, 'background'), 'rgba(20, 36, 53, 0.467)');
  assert.equal(css(upper, 'z-index'), '2147483647', 'The topmost window gets the highest value');
  assert.equal(upper.previousElementSibling, lower, 'No shade for a window without a backdrop');
});

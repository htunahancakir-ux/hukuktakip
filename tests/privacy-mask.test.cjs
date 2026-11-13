const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function setup() {
  const dom = new JSDOM(
    '<header><button id="pmAllContent" class="secondary pm-all" hidden></button></header><h1 id="title">Müvekkiller</h1><div id="content"></div>',
    { url: 'https://test.invalid', runScripts: 'dangerously' },
  );
  const w = dom.window,
    posts = [];
  w.fetch = async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  w.page = 'clients';
  w.eval(fs.readFileSync('outputs/icrapro/privacy-mask.js', 'utf8'));
  return { dom, w, posts };
}

test('Personal values are masked by kind and the real value stays out of the page', () => {
  const { dom, w } = setup();
  try {
    const p = w.hanPrivacy;
    assert.equal(p.mask('id', '12345678901'), '123••••••01');
    assert.equal(p.mask('id', '1234567890'), '123•••••90');
    assert.equal(p.mask('phone', '0 (532) 123 45 67'), '05•• ••• •• 67');
    assert.equal(p.mask('iban', 'TR33 0006 1005 1978 6457 8413 26'), 'TR•• •••• •••• 1326');
    assert.equal(p.mask('email', 'ayse@example.com'), 'a•••@example.com');
    assert.equal(p.mask('address', 'Atatürk Cad. No:5 Kadıköy'), 'Atatürk •••••');
    assert.equal(p.mask('money', '45.000,00 TL'), '•••••');
    assert.equal(p.mask('id', ''), '');
    for (const [label, kind] of [
      ['TC / Vergi No', 'id'],
      ['Ofis TC', 'id'],
      ['TC Kimlik Numarası', 'id'],
      ['Tel-1', 'phone'],
      ['Ref. Tel-2', 'phone'],
      ['Telefon', 'phone'],
      ['IBAN', 'iban'],
      ['E-posta', 'email'],
      ['Açık Adres', 'address'],
      ['Kaynak / Kime Ait', null],
      ['İl / İlçe', null],
      ['Borçlu', null],
      ['Hesap Sahibi', null],
      ['Evrak Teslim Eden', null],
    ])
      assert.equal(p.kindForLabel(label), kind, label);
    const markup = p.html('id', '12345678901') + p.label('Telefon', '<b>05321234567') + p.label('İl', '<i>');
    assert.ok(!markup.includes('12345678901'));
    assert.ok(!markup.includes('05321234567'));
    assert.ok(markup.endsWith('&lt;i&gt;'));
    assert.equal(p.html('id', ''), '');
    assert.equal(p.label('Telefon', ''), '—');
    assert.equal(p.text('id', '12345678901'), '123••••••01');
  } finally {
    dom.window.close();
  }
});

test('A click opens one value, a double click pins it, and Show all works per screen', async () => {
  const { dom, w, posts } = setup();
  try {
    const p = w.hanPrivacy,
      content = w.document.getElementById('content'),
      all = w.document.getElementById('pmAllContent');
    let rowClicks = 0;
    content.innerHTML = `<div id="row">${p.html('id', '12345678901')}${p.html('phone', '05321234567')}</div>`;
    w.document.getElementById('row').onclick = () => rowClicks++;
    await tick();
    assert.equal(all.hidden, true, 'two masked values do not offer Show all');
    const [id, phone] = content.querySelectorAll('.pm');
    id.click();
    assert.equal(id.textContent, '12345678901');
    assert.equal(id.getAttribute('aria-pressed'), 'true');
    assert.equal(phone.textContent, '05•• ••• •• 67');
    assert.equal(rowClicks, 0, 'opening a value does not trigger the row it sits in');
    id.click();
    assert.equal(id.textContent, '12345678901', 'a second click keeps a timed value open');
    id.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    assert.ok(id.classList.contains('pm-pinned'));
    id.click();
    assert.equal(id.textContent, '123••••••01', 'clicking a pinned value masks it again');

    content.insertAdjacentHTML('beforeend', p.html('iban', 'TR330006100519786457841326'));
    await tick();
    assert.equal(all.hidden, false);
    assert.equal(all.textContent, 'Tümünü göster');
    all.click();
    assert.deepEqual(
      [...content.querySelectorAll('.pm')].map((el) => el.textContent),
      ['12345678901', '05321234567', 'TR330006100519786457841326'],
    );
    assert.deepEqual(posts, [{ url: '/api/privacy/reveal', body: { area: 'Müvekkiller', count: 3 } }]);
    await tick();
    assert.equal(all.textContent, 'Gizle');
    // A redraw of the same screen keeps values open; leaving the screen masks again.
    content.innerHTML =
      p.html('id', '11111111111') + p.html('id', '22222222222') + p.html('id', '33333333333');
    await tick();
    assert.equal(content.querySelector('.pm').textContent, '11111111111');
    w.page = 'home';
    content.innerHTML =
      p.html('id', '11111111111') + p.html('id', '22222222222') + p.html('id', '33333333333');
    await tick();
    assert.equal(content.querySelector('.pm').textContent, '111••••••11');
    assert.equal(all.textContent, 'Tümünü göster');
    assert.equal(posts.length, 1);

    content.querySelector('.pm').click();
    p.hideEverything();
    assert.equal(content.querySelector('.pm').textContent, '111••••••11');
  } finally {
    dom.window.close();
  }
});

test('A dialog gets its own Show all button', async () => {
  const { dom, w } = setup();
  try {
    const p = w.hanPrivacy,
      dialog = w.document.createElement('dialog');
    dialog.open = true;
    dialog.innerHTML = `<div class="panelhead"><h2>Borçlu Detayı</h2><button>Kapat</button></div>${p.label('TC / Vergi No', '12345678901')}${p.label('Telefon', '05321234567')}${p.label('Adres', 'Bağdat Cad. 1')}`;
    w.document.body.append(dialog);
    await tick();
    const button = dialog.querySelector('.pm-all');
    assert.ok(button);
    assert.equal(w.document.getElementById('pmAllContent').hidden, true);
    button.click();
    assert.equal(dialog.querySelector('.pm').textContent, '12345678901');
    assert.equal(dialog.dataset.pmAll, '1');
    dialog.open = false;
    dialog.dispatchEvent(new w.Event('close'));
    await tick();
    assert.equal(dialog.dataset.pmAll, undefined);
  } finally {
    dom.window.close();
  }
});

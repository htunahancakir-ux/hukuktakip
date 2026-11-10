const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
};
function pointer(w, target, type, x, y, id = 1) {
  const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: id });
  target.dispatchEvent(e);
}
test('closing edited forms never opens another save prompt or submits the form', async (t) => {
  const dom = new JSDOM(
    '<dialog open><form data-track-draft><input name="name" value="Önceki"><input name="password" type="password"><button>Kaydet</button></form></dialog>',
    { runScripts: 'dangerously', url: 'https://example.test' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    dialog = w.document.querySelector('dialog'),
    form = dialog.querySelector('form');
  let submitted = 0;
  form.onsubmit = (event) => {
    event.preventDefault();
    submitted++;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.eval(fs.readFileSync('outputs/icrapro/modal-dismissal.js', 'utf8'));
  await tick();
  form.elements.name.value = 'Değişti';
  form.elements.password.value = 'Synthetic-Test-Only';
  dialog.dispatchEvent(new w.Event('cancel', { bubbles: false, cancelable: true }));
  assert.equal(dialog.open, false);
  assert.equal(submitted, 0);
  assert.equal(w.document.querySelector('.unsaved-modal'), null);
});
test('Pencereler başlıktan sürüklenir, sınırda erişilebilir kalır ve yeniden açılınca sıfırlanır', async (t) => {
  const dom = new JSDOM(
    '<dialog open><div class="panelhead"><h2>Hesap</h2><button>Kapat</button><input></div></dialog>',
    { runScripts: 'dangerously', url: 'https://example.test' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    d = w.document.querySelector('dialog'),
    h = d.querySelector('.panelhead');
  d.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200 });
  h.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 150, width: 300, height: 50 });
  w.eval(fs.readFileSync('outputs/icrapro/modal-dismissal.js', 'utf8'));
  await tick();
  assert(h.classList.contains('modal-drag-handle'));
  pointer(w, h.querySelector('h2'), 'pointerdown', 120, 110);
  pointer(w, w.document, 'pointermove', 220, 160);
  pointer(w, w.document, 'pointerup', 220, 160);
  assert.equal(d.style.translate, '100px 50px');
  assert.equal(d.open, true);
  w.dispatchEvent(new w.Event('resize'));
  assert.equal(d.style.translate, '');
  pointer(w, h, 'pointerdown', 120, 110);
  pointer(w, w.document, 'pointermove', -9000, -9000);
  pointer(w, w.document, 'pointerup', -9000, -9000);
  assert.equal(d.style.translate, '-304px -92px');
  d.open = false;
  await tick();
  assert.equal(d.style.translate, '');
  d.open = true;
  await tick();
  pointer(w, h.querySelector('button'), 'pointerdown', 150, 120);
  pointer(w, w.document, 'pointermove', 200, 180);
  pointer(w, w.document, 'pointerup', 200, 180);
  assert.equal(d.style.translate, '');
  pointer(w, h.querySelector('input'), 'pointerdown', 150, 120);
  pointer(w, w.document, 'pointermove', 200, 180);
  pointer(w, w.document, 'pointerup', 200, 180);
  assert.equal(d.style.translate, '');
  const second = w.document.createElement('dialog');
  second.innerHTML = '<h2>Yeni pencere</h2>';
  second.open = true;
  w.document.body.append(second);
  await tick();
  assert(second.querySelector('h2').classList.contains('modal-drag-handle'));
});

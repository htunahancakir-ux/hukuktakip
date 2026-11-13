// Ayarlar → Firma Bilgileri → "Yazıları Düzenle": the texts on the login screen's picture.
// The stage is a scaled copy of the login picture panel on a 1440 × 900 screen, as tall as the
// window allows (the buttons sit in the side column to leave it the height). Texts are
// dragged into place, resized with the corner handle or the size slider, edited on the side and
// saved together (PUT /api/login-texts). Drawing is shared with the login screen
// (loginTextElement / placeLoginText in login-layout.js), so both show the same layout.
const LOGIN_TEXT_STYLES = [
  ['brand', 'Marka (logolu)'],
  ['heading', 'Başlık'],
  ['text', 'Metin'],
  ['label', 'Etiket (büyük harf)'],
];
const LOGIN_TEXT_COLORS = [
  ['white', 'Beyaz'],
  ['gold', 'Altın'],
  ['soft', 'Gri'],
];
const LOGIN_TEXT_LIMITS = { count: 12, min: 0.8, max: 14 };
// Changes not yet saved when the window was closed; offered again on the next opening.
let loginTextsDraft = null;

function openLoginTextsEditor({ saved, artVersion, onSaved }) {
  document.getElementById('loginTextsDialog')?.remove();
  const baseline = JSON.stringify(saved || LOGIN_TEXT_DEFAULTS);
  let items = structuredClone(loginTextsDraft || saved || LOGIN_TEXT_DEFAULTS);
  const restored = !!loginTextsDraft;
  let selected = null,
    drag = null,
    finished = false;
  const option = ([value, label]) => `<option value="${value}">${label}</option>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'loginTextsDialog';
  dialog.innerHTML = `<div class="panelhead"><div><h2>Giriş Ekranı Yazıları</h2><p>Yazıyı tutup sürükleyin, köşedeki tutamaçla büyütüp küçültün. Seçili yazı ok tuşlarıyla da kayar.</p></div><button type="button" class="link">Kapat</button></div>
    <div class="lte-body">
      <div class="lte-stage" aria-label="Giriş ekranı önizlemesi">
        <img class="lte-art" alt="" src="/api/login-art?v=${encodeURIComponent(artVersion || 'varsayilan')}">
        <div class="lte-shade" aria-hidden="true"></div>
        <div class="lte-layer"></div>
      </div>
      <div class="lte-side">
        <button type="button" class="secondary" data-lte-add title="Önizlemenin ortasına yeni bir yazı ekler">+ Yazı Ekle</button>
        <fieldset class="lte-props" disabled>
          <legend>Seçili yazı</legend>
          <p class="lte-hint" role="status"></p>
          <label class="field">Metin<textarea rows="3" maxlength="300" data-lte="text"></textarea></label>
          <div class="lte-pair">
            <label class="field">Biçim<select data-lte="style">${LOGIN_TEXT_STYLES.map(option).join('')}</select></label>
            <label class="field">Renk<select data-lte="color">${LOGIN_TEXT_COLORS.map(option).join('')}</select></label>
          </div>
          <label class="settings-check"><input type="checkbox" data-lte="bold"> Kalın yazı</label>
          <label class="field">Boyut<span class="lte-size"><input type="range" min="${LOGIN_TEXT_LIMITS.min}" max="${LOGIN_TEXT_LIMITS.max}" step="0.05" data-lte="size"><output data-lte-size></output></span></label>
          <button type="button" class="link lte-delete" data-lte-delete>Yazıyı Sil</button>
        </fieldset>
        <div class="lte-actions"><button type="button" class="primary" data-lte-save>Kaydet</button><button type="button" class="secondary">Vazgeç</button><button type="button" class="link lte-default" data-lte-default>Varsayılan Yazılara Dön</button></div>
      </div>
    </div>`;
  document.body.append(dialog);
  const $d = (selector) => dialog.querySelector(selector);
  const stage = $d('.lte-stage'),
    layer = loginTextLayer([], $d('.lte-layer')),
    props = $d('.lte-props'),
    hint = $d('.lte-hint'),
    add = $d('[data-lte-add]'),
    control = (name) => $d(`[data-lte="${name}"]`);
  const art = $d('.lte-art');
  art.addEventListener('error', () => (art.src = assetUrl('login-justice-v1.png')), { once: true });

  const current = () => items.find((item) => item.id === selected) || null;
  const elementOf = (id) => [...layer.children].find((el) => el.dataset.textId === id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  const dirty = () => JSON.stringify(items) !== baseline;
  const percent = (size) => size.toLocaleString('tr-TR', { maximumFractionDigits: 1 });

  function render() {
    layer.replaceChildren(
      ...items.map((item) => {
        const el = loginTextElement(item);
        el.classList.add('lte-item');
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'Yazı: ' + item.text.replace(/\s+/g, ' ').slice(0, 60));
        if (item.id === selected) {
          el.classList.add('is-selected');
          const handle = document.createElement('span');
          handle.className = 'lte-handle';
          handle.title = 'Büyütmek veya küçültmek için sürükleyin';
          el.append(handle);
        }
        return el;
      }),
    );
    syncProps();
  }

  function syncProps() {
    const item = current();
    props.disabled = !item;
    add.disabled = items.length >= LOGIN_TEXT_LIMITS.count;
    add.title =
      items.length >= LOGIN_TEXT_LIMITS.count
        ? `En fazla ${LOGIN_TEXT_LIMITS.count} yazı eklenebilir.`
        : 'Önizlemenin ortasına yeni bir yazı ekler';
    hint.textContent = item
      ? 'Değişiklikler önizlemede hemen görünür; Kaydet ile giriş ekranına geçer.'
      : restored && dirty()
        ? 'Kaydedilmemiş değişiklikleriniz geri yüklendi. Düzenlemek için bir yazıya tıklayın.'
        : 'Düzenlemek için önizlemede bir yazıya tıklayın.';
    const text = control('text');
    if (document.activeElement !== text) text.value = item ? item.text : '';
    control('style').value = item ? item.style : 'text';
    control('color').value = item ? item.color : 'white';
    control('bold').checked = !!item?.bold;
    control('size').value = item ? item.size : 2;
    $d('[data-lte-size]').textContent = item ? percent(item.size) : '';
  }

  function select(id) {
    selected = id;
    render();
    if (id) elementOf(id)?.focus({ preventScroll: true });
  }

  // Dragging: the stage holds the pointer, so the text can be redrawn while it moves.
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const el = event.target.closest('.lte-item');
    if (!el) return select(null);
    event.preventDefault();
    const resize = event.target.classList.contains('lte-handle');
    if (selected !== el.dataset.textId) select(el.dataset.textId);
    const item = current(),
      box = stage.getBoundingClientRect();
    drag = {
      pointer: event.pointerId,
      resize,
      x0: event.clientX,
      y0: event.clientY,
      x: item.x,
      y: item.y,
      size: item.size,
      width: box.width,
      height: box.height,
      textWidth: Math.max(40, elementOf(item.id).getBoundingClientRect().width),
    };
    stage.setPointerCapture(event.pointerId);
    elementOf(item.id).focus({ preventScroll: true });
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const item = current(),
      dx = event.clientX - drag.x0,
      dy = event.clientY - drag.y0;
    if (drag.resize)
      item.size = clamp(drag.size * (1 + dx / drag.textWidth), LOGIN_TEXT_LIMITS.min, LOGIN_TEXT_LIMITS.max);
    else {
      item.x = clamp(drag.x + (dx / drag.width) * 100, 0, 97);
      item.y = clamp(drag.y + (dy / drag.height) * 100, 0, 97);
    }
    placeLoginText(elementOf(item.id), item);
    syncProps();
  });
  const release = (event) => {
    if (drag && event.pointerId === drag.pointer) drag = null;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // Keyboard: arrows move (Shift: further), + and - resize, Delete removes the selected text.
  layer.addEventListener('keydown', (event) => {
    const el = event.target.closest('.lte-item');
    if (!el) return;
    if (selected !== el.dataset.textId && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      return select(el.dataset.textId);
    }
    if (selected !== el.dataset.textId) return;
    const item = current(),
      step = event.shiftKey ? 2 : 0.5,
      moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      item.x = clamp(item.x + moves[event.key][0], 0, 97);
      item.y = clamp(item.y + moves[event.key][1], 0, 97);
    } else if (['+', '=', '-'].includes(event.key))
      item.size = clamp(
        item.size + (event.key === '-' ? -1 : 1) * (event.shiftKey ? 0.5 : 0.1),
        LOGIN_TEXT_LIMITS.min,
        LOGIN_TEXT_LIMITS.max,
      );
    else if (['Delete', 'Backspace'].includes(event.key)) return remove();
    else return;
    event.preventDefault();
    placeLoginText(el, item);
    syncProps();
  });

  control('text').addEventListener('input', (event) => {
    current().text = event.target.value;
    render();
  });
  for (const name of ['style', 'color'])
    control(name).addEventListener('change', (event) => {
      current()[name] = event.target.value;
      render();
    });
  control('bold').addEventListener('change', (event) => {
    current().bold = event.target.checked;
    render();
  });
  control('size').addEventListener('input', (event) => {
    const item = current();
    item.size = clamp(Number(event.target.value), LOGIN_TEXT_LIMITS.min, LOGIN_TEXT_LIMITS.max);
    placeLoginText(elementOf(item.id), item);
    $d('[data-lte-size]').textContent = percent(item.size);
  });

  add.addEventListener('click', () => {
    if (items.length >= LOGIN_TEXT_LIMITS.count) return;
    const id = 'yazi-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    items.push({
      id,
      text: 'Yeni yazı',
      style: 'text',
      color: 'white',
      bold: false,
      x: 15,
      y: 45,
      size: 2.4,
    });
    select(id);
    const text = control('text');
    text.focus();
    text.select();
  });
  function remove() {
    if (!current()) return;
    items = items.filter((item) => item.id !== selected);
    select(null);
  }
  $d('[data-lte-delete]').addEventListener('click', remove);

  const request = async (method, body) => {
    const response = await fetch('/api/login-texts', {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Giriş ekranı yazıları kaydedilemedi.');
    return result;
  };
  const busy = (on) =>
    dialog.querySelectorAll('.lte-actions button').forEach((button) => (button.disabled = on));

  $d('[data-lte-save]').addEventListener('click', async () => {
    const empty = items.find((item) => !item.text.trim());
    if (empty) {
      select(empty.id);
      control('text').focus();
      return toast('Boş yazı kaydedilemez. Metin girin ya da yazıyı silin.');
    }
    busy(true);
    try {
      const result = await request('PUT', { texts: items });
      finished = true;
      loginTextsDraft = null;
      dialog.close();
      onSaved?.(result.texts);
      toast('Giriş ekranı yazıları kaydedildi.');
    } catch (error) {
      toast(error.message);
    } finally {
      busy(false);
    }
  });
  $d('[data-lte-default]').addEventListener('click', async () => {
    if (!confirm('Giriş ekranında varsayılan yazılar kullanılsın mı? Eklediğiniz yazılar silinir.')) return;
    busy(true);
    try {
      if (saved) await request('DELETE');
      finished = true;
      loginTextsDraft = null;
      dialog.close();
      onSaved?.(null);
      toast('Büroya özel yazılar kaldırıldı; giriş ekranında varsayılan yazılar kullanılacak.');
    } catch (error) {
      toast(error.message);
    } finally {
      busy(false);
    }
  });
  // Kapat / Vazgeç / Esc close the window (modal-dismissal.js); unsaved work is kept for later.
  dialog.addEventListener('close', () => {
    if (!finished) loginTextsDraft = dirty() ? structuredClone(items) : null;
    dialog.remove();
  });

  render();
  dialog.showModal();
  return dialog;
}

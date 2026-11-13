// KVKK screen masking. Personal data is drawn masked for everyone, so a screenshot or a
// glance over the shoulder shows nothing. A user who may see the record opens a value by
// clicking it, or opens everything with "Tümünü göster", which then stays on across screens
// until the user masks again or stops using the application for a while.
// This is a display layer only: stored records and form inputs keep real values.
(() => {
  const REVEAL_MS = 30000,
    IDLE_MS = 15 * 60000,
    OFFER_MS = 8000;
  const values = new Map();
  const timers = new Map();
  let sequence = 0,
    allMode = false,
    idleTimer,
    scanQueued = false;

  const escape = escapeHtml; // html-safety.js
  const dots = (count) => '•'.repeat(Math.max(1, count));

  function mask(kind, value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (kind === 'id') {
      const compact = text.replace(/\s/g, '');
      return compact.length <= 5
        ? dots(compact.length)
        : compact.slice(0, 3) + dots(compact.length - 5) + compact.slice(-2);
    }
    if (kind === 'phone') {
      const digits = text.replace(/\D/g, '');
      return digits.length < 7 ? dots(6) : digits.slice(0, 2) + '•• ••• •• ' + digits.slice(-2);
    }
    if (kind === 'iban') {
      const compact = text.replace(/\s/g, '');
      return compact.length < 8 ? dots(8) : compact.slice(0, 2) + '•• •••• •••• ' + compact.slice(-4);
    }
    if (kind === 'email') {
      const at = text.indexOf('@');
      return at < 1 ? dots(6) : text[0] + '•••' + text.slice(at);
    }
    if (kind === 'address') return text.split(/\s+/)[0].slice(0, 12) + ' •••••';
    return dots(5);
  }

  // Which kind of personal data a field label announces; null when it is not sensitive.
  function kindForLabel(label) {
    const text = String(label ?? '')
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i');
    if (/iban/.test(text)) return 'iban';
    if (/(^|[^a-zçğıöşü])(tc|t\.c\.?)([^a-zçğıöşü]|$)|kimlik|vergi no/.test(text)) return 'id';
    if (/(^|[^a-zçğıöşü])(tel|gsm|whatsapp)/.test(text) && !/kaynak|kime ait/.test(text)) return 'phone';
    if (/e-?posta/.test(text)) return 'email';
    if (/adres/.test(text)) return 'address';
    return null;
  }

  // Interactive masked value. `shown` is the formatted text to reveal (defaults to the value).
  function html(kind, value, shown) {
    const text = String(shown ?? value ?? '').trim();
    if (!text) return '';
    const id = 'pm' + ++sequence;
    values.set(id, { text, mask: mask(kind, value) });
    if (values.size > 4000) prune();
    return (
      '<button type="button" class="pm" data-pm="' +
      id +
      '" aria-pressed="false" title="Göstermek için tıklayın; açık tutmak için çift tıklayın">' +
      escape(values.get(id).mask) +
      '</button>'
    );
  }

  // Masked text for places that cannot hold a button (options, clickable rows).
  const text = (kind, value) => escape(mask(kind, value));

  const label = (name, value, empty = '—') => {
    const kind = kindForLabel(name);
    return (kind && html(kind, value)) || escape(value || empty);
  };

  function prune() {
    for (const id of values.keys())
      if (!document.querySelector('[data-pm="' + id + '"]')) {
        values.delete(id);
        clearTimeout(timers.get(id));
        timers.delete(id);
      }
  }

  function hide(el) {
    const entry = values.get(el.dataset.pm);
    clearTimeout(timers.get(el.dataset.pm));
    timers.delete(el.dataset.pm);
    if (entry) el.textContent = entry.mask;
    el.classList.remove('pm-open', 'pm-pinned');
    el.setAttribute('aria-pressed', 'false');
  }

  function show(el, pinned) {
    const id = el.dataset.pm,
      entry = values.get(id);
    if (!entry) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    el.textContent = entry.text;
    el.classList.add('pm-open');
    el.classList.toggle('pm-pinned', !!pinned);
    el.setAttribute('aria-pressed', 'true');
    if (!pinned)
      timers.set(
        id,
        setTimeout(() => el.isConnected && hide(el), REVEAL_MS),
      );
  }

  const scopeOf = (el) => el.closest('dialog') || document.getElementById('content');
  const fields = (scope) =>
    scope ? [...scope.querySelectorAll('.pm')].filter((el) => scopeOf(el) === scope) : [];
  const everyField = () => [...document.querySelectorAll('.pm')];

  // Writes the audit entry; false (with a notice) when it could not be written.
  async function record(area, count, kind) {
    try {
      const response = await fetch('/api/privacy/reveal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ area: String(area || 'Ekran').slice(0, 120), count, kind }),
      });
      if (!response.ok) throw Error();
      return true;
    } catch {
      window.toast?.('İşlem kaydı yazılamadı; işlem yapılmadı. Yeniden deneyin.');
      return false;
    }
  }

  // Show all stays on from screen to screen. It ends when the user masks again, leaves the
  // application, or does nothing for IDLE_MS.
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (allMode) idleTimer = setTimeout(() => setAll(false), IDLE_MS);
  };
  async function setAll(on, origin) {
    if (on === allMode) return;
    if (on) {
      const dialog = origin?.closest?.('dialog'),
        area =
          (dialog ? dialog.querySelector('h2') : document.getElementById('title'))?.textContent || 'Ekran';
      // Recorded first; without the record nothing is opened. Single values are not recorded.
      if (!(await record(area.trim() + ' · tüm ekranlar', everyField().length))) return;
    }
    allMode = on;
    armIdle();
    document.querySelector('.pm-offer')?.remove();
    for (const el of everyField()) {
      delete el.dataset.pmHeld;
      on ? show(el, true) : hide(el);
    }
    scan();
  }

  function hideEverything() {
    allMode = false;
    clearTimeout(idleTimer);
    for (const el of document.querySelectorAll('.pm.pm-open')) hide(el);
    scan();
  }

  // After two values are open side by side, opening a third offers to open everything.
  function offer(el) {
    document.querySelector('.pm-offer')?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pm-all pm-offer';
    button.textContent = 'Tümünü göster';
    el.after(button);
    setTimeout(() => button.remove(), OFFER_MS);
  }

  function toggleButton(scope) {
    const dialog = scope.matches('dialog');
    let button = dialog
      ? [...scope.querySelectorAll('.pm-all:not(.pm-offer)')].find((el) => el.closest('dialog') === scope)
      : document.getElementById('pmAllContent');
    if (!fields(scope).length && !(allMode && !dialog)) {
      if (dialog) button?.remove();
      else if (button) button.hidden = true;
      return;
    }
    if (!button) {
      if (!dialog) return;
      const head = [...scope.querySelectorAll('.panelhead')].find((el) => el.closest('dialog') === scope);
      if (!head) return;
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary pm-all';
      const toolbar = head.querySelector('.toolbar');
      if (toolbar) toolbar.prepend(button);
      else (head.lastElementChild || head).before(button);
    }
    const text = allMode ? 'Gizle' : 'Tümünü göster';
    button.hidden = false;
    if (button.textContent.trim() !== text) button.textContent = text;
    button.setAttribute('aria-pressed', String(allMode));
    button.title = allMode
      ? 'Kişisel verileri yeniden maskele'
      : 'Maskeli kişisel verilerin tümünü göster. Siz gizleyene kadar diğer ekranlarda da açık kalır.';
  }

  function scan() {
    scanQueued = false;
    const scopes = [document.getElementById('content'), ...document.querySelectorAll('dialog[open]')].filter(
      Boolean,
    );
    for (const scope of scopes) {
      // While Show all is on, values drawn later open too, except those the user closed by hand.
      if (allMode)
        for (const el of fields(scope))
          if (!el.classList.contains('pm-open') && !el.dataset.pmHeld) show(el, true);
      toggleButton(scope);
    }
  }
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 0);
  }

  // Capture phase: a masked value inside a clickable row must not trigger the row.
  document.addEventListener(
    'click',
    (event) => {
      const all = event.target.closest?.('.pm-all');
      if (all) {
        event.preventDefault();
        event.stopPropagation();
        return setAll(all.classList.contains('pm-offer') ? true : !allMode, all);
      }
      const el = event.target.closest?.('.pm');
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      // A second click keeps a timed value open; a click on a pinned one closes it.
      if (el.classList.contains('pm-pinned')) {
        if (allMode) el.dataset.pmHeld = '1';
        return hide(el);
      }
      const others = fields(scopeOf(el)).filter(
        (other) => other !== el && other.classList.contains('pm-open'),
      );
      show(el, false);
      if (others.length >= 2) offer(el);
    },
    true,
  );
  document.addEventListener('dblclick', (event) => {
    const el = event.target.closest?.('.pm');
    if (!el) return;
    event.preventDefault();
    show(el, true);
  });
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, armIdle, true);
  document.addEventListener('close', (event) => event.target.matches?.('dialog') && queueScan(), true);
  // Values opened one by one are masked again when the window goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !allMode) hideEverything();
  });
  window.addEventListener('pagehide', hideEverything);
  const start = () => {
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    queueScan();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  window.hanPrivacy = { mask, kindForLabel, html, text, label, record, hideEverything, scan };
})();

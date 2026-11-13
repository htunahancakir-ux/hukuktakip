// KVKK screen masking. Personal data is drawn masked for everyone, so a screenshot or a
// glance over the shoulder shows nothing. A user who may see the record opens a value by
// clicking it. This is a display layer only: stored records and form inputs keep real values.
(() => {
  const REVEAL_MS = 30000;
  const values = new Map();
  const timers = new Map();
  let sequence = 0,
    contentAll = false,
    lastPage = '',
    scanQueued = false;

  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
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
  const allOn = (scope) => (scope?.matches?.('dialog') ? scope.dataset.pmAll === '1' : contentAll);
  const fields = (scope) =>
    scope ? [...scope.querySelectorAll('.pm')].filter((el) => scopeOf(el) === scope) : [];

  function setAll(scope, on, report) {
    if (!scope) return;
    if (scope.matches('dialog')) on ? (scope.dataset.pmAll = '1') : delete scope.dataset.pmAll;
    else contentAll = on;
    const list = fields(scope);
    for (const el of list) on ? show(el, true) : hide(el);
    if (on && report && list.length && typeof fetch === 'function') {
      const area = scope.matches('dialog')
        ? scope.querySelector('h2')?.textContent
        : document.getElementById('title')?.textContent;
      // Opening everything at once is recorded; opening a single value is not.
      fetch('/api/privacy/reveal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ area: String(area || 'Ekran').slice(0, 120), count: list.length }),
      }).catch(() => {});
    }
    scan();
  }

  function hideEverything() {
    contentAll = false;
    for (const dialog of document.querySelectorAll('dialog[data-pm-all]')) delete dialog.dataset.pmAll;
    for (const el of document.querySelectorAll('.pm.pm-open')) hide(el);
    scan();
  }

  function toggleButton(scope) {
    const dialog = scope.matches('dialog');
    let button = dialog
      ? [...scope.querySelectorAll('.pm-all')].find((el) => el.closest('dialog') === scope)
      : document.getElementById('pmAllContent');
    const count = fields(scope).length;
    if (count <= 2) {
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
    const on = allOn(scope),
      text = on ? 'Gizle' : 'Tümünü göster';
    button.hidden = false;
    if (button.textContent !== text) button.textContent = text;
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'Bu ekrandaki kişisel verileri yeniden maskele'
      : 'Bu ekrandaki maskeli kişisel verilerin tümünü ekran değişene kadar göster';
  }

  function scan() {
    scanQueued = false;
    const current = typeof page === 'undefined' ? '' : page;
    if (current !== lastPage) {
      lastPage = current;
      contentAll = false;
    }
    const scopes = [document.getElementById('content'), ...document.querySelectorAll('dialog')].filter(
      Boolean,
    );
    for (const scope of scopes) {
      const dialog = scope.matches('dialog');
      if (dialog && !scope.open) {
        delete scope.dataset.pmAll;
        continue;
      }
      // A redraw inside a screen that was opened in full keeps its new values open too.
      if (allOn(scope))
        for (const el of fields(scope)) if (!el.classList.contains('pm-pinned')) show(el, true);
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
        const scope = all.id === 'pmAllContent' ? document.getElementById('content') : all.closest('dialog');
        return setAll(scope, !allOn(scope), true);
      }
      const el = event.target.closest?.('.pm');
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      // A second click keeps a timed value open; a click on a pinned one closes it.
      if (el.classList.contains('pm-pinned')) hide(el);
      else show(el, false);
    },
    true,
  );
  document.addEventListener('dblclick', (event) => {
    const el = event.target.closest?.('.pm');
    if (!el) return;
    event.preventDefault();
    show(el, true);
  });
  document.addEventListener('close', (event) => event.target.matches?.('dialog') && queueScan(), true);
  document.addEventListener('visibilitychange', () => document.hidden && hideEverything());
  window.addEventListener('pagehide', hideEverything);
  const start = () => {
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    queueScan();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  window.hanPrivacy = { mask, kindForLabel, html, text, label, hideEverything, scan };
})();

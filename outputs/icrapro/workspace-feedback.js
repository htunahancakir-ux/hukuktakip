// Geri bildirim: a header button opens a window to send a bug report (hata), suggestion (öneri)
// or question (soru) to technical support, with a screenshot of the page taken automatically
// (html2canvas, no browser permission prompt). The sender can leave the screenshot out.
// CEO and admins see every entry and answer it; everyone else sees their own entries.
const FEEDBACK_KINDS = { bug: 'Hata', suggestion: 'Öneri', question: 'Soru' };
const FEEDBACK_STATUSES = { open: 'Açık', answered: 'Yanıtlandı', closed: 'Kapandı' };
const feedbackUi = { shot: null, loading: null };

async function feedbackApi(url, method = 'GET', data) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Han-Request': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    throw Error('Sunucuya ulaşılamadı.');
  }
  if (!response.ok) throw Error(result.error || 'İşlem tamamlanamadı.');
  return result;
}

function loadFeedbackCapture() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  feedbackUi.loading ||= loadClassicScript('html2canvas.min.js').then(() => window.html2canvas);
  return feedbackUi.loading;
}

// The visible part of the page as a JPEG data URL, or null when it cannot be taken. The feedback
// window, Verimor's web phone and other iframes are left out.
async function captureFeedbackScreen() {
  // html2canvas draws from a copy of the page, and the copy has no top layer: an open window
  // would fall back into the page flow, usually below the visible part, and miss the picture.
  // Each one is pinned in the copy where it is on screen, above its dimmed backdrop.
  const windows = feedbackOpenModals().filter((d) => d.id !== 'feedbackDialog');
  const placed = windows.map((dialog, i) => {
    dialog.setAttribute('data-feedback-layer', String(i));
    let backdrop = '';
    try {
      backdrop = getComputedStyle(dialog, '::backdrop').backgroundColor;
    } catch {}
    return { rect: dialog.getBoundingClientRect(), backdrop };
  });
  try {
    const capture = await loadFeedbackCapture();
    const canvas = await capture(document.body, {
      logging: false,
      useCORS: true,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      scale: Math.min(window.devicePixelRatio || 1, 1.5),
      ignoreElements: (el) =>
        el.id === 'feedbackDialog' ||
        el.id === 'voipWebphone' ||
        el.tagName === 'IFRAME' ||
        el.hasAttribute?.('data-feedback-open'),
      onclone: (copy) => pinFeedbackWindows(copy, placed),
    });
    // Large screens are scaled down so the image stays well under the upload limit.
    const width = Math.min(canvas.width, 1600);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = Math.round((canvas.height * width) / canvas.width);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  } finally {
    windows.forEach((dialog) => dialog.removeAttribute('data-feedback-layer'));
  }
}

function pinFeedbackWindows(copy, placed) {
  copy.querySelectorAll('[data-feedback-layer]').forEach((dialog) => {
    const index = Number(dialog.dataset.feedbackLayer);
    const { rect, backdrop } = placed[index] || {};
    if (!rect) return;
    // The topmost window gets the highest z-index there is, its backdrop the one below: on
    // screen every fixed bar of the page (some use these values too) is under them.
    const layer = 2147483646 - 2 * (placed.length - 1 - index);
    if (backdrop && backdrop !== 'rgba(0, 0, 0, 0)' && backdrop !== 'transparent') {
      const shade = copy.createElement('div');
      shade.style.cssText = `position:fixed;inset:0;background:${backdrop};z-index:${layer}`;
      dialog.before(shade);
    }
    // Inline margins (the window keeps its place while it grows) and the drag offset are
    // already part of the measured box, so they are cleared rather than applied twice.
    const pin = {
      position: 'fixed',
      inset: 'auto',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      'box-sizing': 'border-box',
      margin: '0',
      translate: 'none',
      transform: 'none',
      'max-width': 'none',
      'max-height': 'none',
      'min-height': '0',
      'z-index': String(layer + 1),
    };
    for (const [property, value] of Object.entries(pin))
      dialog.style.setProperty(property, value, 'important');
  });
}

function feedbackDialog() {
  let dialog = document.getElementById('feedbackDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'feedbackDialog';
    dialog.className = 'feedback-dialog';
    document.body.append(dialog);
  }
  return dialog;
}

async function openFeedback() {
  // The screenshot is taken before the window opens, so it shows the page as the user saw it.
  const button = feedbackEdgeButton();
  if (button?.disabled) return;
  if (button) button.disabled = true;
  feedbackUi.shot = await captureFeedbackScreen();
  if (button) button.disabled = false;
  const dialog = feedbackDialog();
  dialog.innerHTML = `<div class="panelhead"><h2>Geri bildirim</h2><button type="button" class="secondary" data-close>Kapat</button></div>
    <div class="settings-tabs feedback-tabs" role="tablist" aria-label="Geri bildirim">
      <button type="button" role="tab" class="selected" aria-selected="true" data-feedback-tab="new">Yeni bildirim</button>
      <button type="button" role="tab" aria-selected="false" data-feedback-tab="list">${
        ['ceo', 'admin'].includes(hanAuth?.role) ? 'Gelen bildirimler' : 'Gönderdiklerim'
      }</button>
    </div>
    <form class="formbody feedback-form" data-feedback-new>
      <div class="field"><span>Tür</span><div class="feedback-kinds">${Object.entries(FEEDBACK_KINDS)
        .map(
          ([value, label], i) =>
            `<label><input type="radio" name="kind" value="${value}" ${i === 0 ? 'checked' : ''}> ${label}</label>`,
        )
        .join('')}</div></div>
      <label class="field">Kime<select name="target">
        <option value="support" selected>Teknik destek</option>
        <option value="sales" disabled>Satış ve pazarlama (yakında)</option>
      </select></label>
      <label class="field">Açıklama<textarea name="message" rows="5" maxlength="3000" required placeholder="Ne oldu, ne bekliyordunuz? Öneri veya sorunuzu yazın."></textarea></label>
      ${
        feedbackUi.shot
          ? `<label class="feedback-shot-toggle"><input type="checkbox" name="withShot" checked> Ekran görüntüsünü ekle</label>
             <img class="feedback-shot" alt="Gönderilecek ekran görüntüsü" src="${feedbackUi.shot}">
             <small>Ekran görüntüsünde müvekkil ve borçlu bilgileri görünebilir; göndermek istemezseniz işareti kaldırın.</small>`
          : '<small>Ekran görüntüsü alınamadı; yalnızca yazdığınız açıklama gönderilecek.</small>'
      }
      <p role="status" data-feedback-status></p>
      <div class="feedback-actions"><button class="primary" data-feedback-send>Gönder</button></div>
    </form>
    <div class="formbody feedback-list" data-feedback-list hidden></div>`;
  const form = dialog.querySelector('[data-feedback-new]');
  const list = dialog.querySelector('[data-feedback-list]');
  const shot = dialog.querySelector('.feedback-shot');
  const toggle = form.elements.withShot;
  if (toggle) toggle.onchange = () => (shot.hidden = !toggle.checked);
  const showTab = (tab) => {
    dialog.querySelectorAll('[data-feedback-tab]').forEach((b) => {
      const selected = b.dataset.feedbackTab === tab;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-selected', String(selected));
    });
    form.hidden = tab !== 'new';
    list.hidden = tab !== 'list';
    if (tab === 'list') renderFeedbackList(list);
  };
  dialog
    .querySelectorAll('[data-feedback-tab]')
    .forEach((b) => (b.onclick = () => showTab(b.dataset.feedbackTab)));
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-feedback-status]');
    const send = form.querySelector('[data-feedback-send]');
    send.disabled = true;
    status.textContent = 'Gönderiliyor…';
    try {
      const result = await feedbackApi('/api/feedback', 'POST', {
        kind: form.elements.kind.value,
        target: form.elements.target.value,
        message: form.elements.message.value,
        page: location.pathname + location.hash,
        screenshot: toggle?.checked ? feedbackUi.shot : undefined,
      });
      form.reset();
      feedbackUi.shot = null;
      showTab('list');
      toast(
        result.screenshotDropped
          ? 'Geri bildiriminiz gönderildi; ekran görüntüsü kaydedilemedi.'
          : 'Geri bildiriminiz gönderildi. Teşekkürler.',
        dialog,
      );
    } catch (error) {
      status.textContent = error.message;
    } finally {
      send.disabled = false;
    }
  };
  dialog.showModal();
}

async function renderFeedbackList(box) {
  box.textContent = 'Yükleniyor…';
  let data;
  try {
    data = await feedbackApi('/api/feedback');
  } catch (error) {
    box.textContent = error.message;
    return;
  }
  if (!data.items.length) {
    box.innerHTML = '<p class="empty">Henüz geri bildirim yok.</p>';
    return;
  }
  const when = (iso) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  box.innerHTML = data.items
    .map(
      (f) => `<article class="feedback-item" data-id="${esc(f.id)}" data-status="${esc(f.status)}">
        <header><span class="feedback-kind feedback-${esc(f.kind)}">${FEEDBACK_KINDS[f.kind] || esc(f.kind)}</span>
          <span class="feedback-status feedback-status-${esc(f.status)}">${FEEDBACK_STATUSES[f.status] || esc(f.status)}</span>
          <small>${esc(when(f.createdAt))}${data.manager ? ' · ' + esc(f.userName || '') : ''}${f.page ? ' · ' + esc(f.page) : ''}</small></header>
        <p class="feedback-message">${esc(f.message)}</p>
        ${f.screenshot ? '<button type="button" class="link" data-feedback-shot>Ekran görüntüsünü göster</button><div data-feedback-image></div>' : ''}
        ${(f.replies || [])
          .map(
            (r) =>
              `<div class="feedback-reply"><small>${esc(r.by || '')} · ${esc(when(r.at))}</small><p>${esc(r.message)}</p></div>`,
          )
          .join('')}
        ${
          data.manager
            ? `<form class="feedback-answer" data-feedback-answer><textarea name="message" rows="2" maxlength="3000" placeholder="Yanıt yazın"></textarea>
               <select name="status" aria-label="Durum">${Object.entries(FEEDBACK_STATUSES)
                 .map(([v, l]) => `<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`)
                 .join('')}</select>
               <button class="secondary">Kaydet</button><span role="status" data-answer-status></span></form>`
            : ''
        }
      </article>`,
    )
    .join('');
  box.querySelectorAll('.feedback-item').forEach((item) => {
    const id = item.dataset.id;
    const showShot = item.querySelector('[data-feedback-shot]');
    if (showShot)
      showShot.onclick = async () => {
        const holder = item.querySelector('[data-feedback-image]');
        showShot.disabled = true;
        try {
          const { dataUrl } = await feedbackApi('/api/feedback/screenshot?id=' + encodeURIComponent(id));
          const img = document.createElement('img');
          img.className = 'feedback-shot';
          img.alt = 'Ekran görüntüsü';
          img.src = dataUrl;
          holder.replaceChildren(img);
          showShot.hidden = true;
        } catch (error) {
          holder.textContent = error.message;
          showShot.disabled = false;
        }
      };
    const answer = item.querySelector('[data-feedback-answer]');
    if (answer)
      answer.onsubmit = async (event) => {
        event.preventDefault();
        const status = answer.querySelector('[data-answer-status]');
        try {
          const chosen = answer.elements.status.value;
          // A reply with the status left as it was marks the entry "Yanıtlandı".
          await feedbackApi('/api/feedback/reply', 'POST', {
            id,
            message: answer.elements.message.value,
            status: chosen === item.dataset.status ? undefined : chosen,
          });
          renderFeedbackList(box);
        } catch (error) {
          status.textContent = error.message;
        }
      };
  });
}

// The Geri bildirim tab is fixed to the right edge of the screen on every page and must stay above
// everything, open windows included, or a problem in a window could not be reported with its
// screenshot. No z-index lifts it over a window opened with showModal(): such a window is in the
// browser's top layer, and the rest of the page is inert (visible, but clicks do nothing). So the
// tab is a popover, itself in the top layer and raised again after every window or popover that
// opens, and it moves into the topmost open window, the only part of the page that still takes
// clicks. Its button lives in a shadow root: window code that disables or removes every button
// in a window, and window styles, cannot reach it.
const feedbackEdge = { host: null, modals: [], watching: false, raising: false };
const FEEDBACK_EDGE_CSS = `
  :host { position: fixed; inset: 50% 0 auto auto; translate: 0 -50%; margin: 0; padding: 0; border: 0;
    background: none; color: inherit; overflow: visible; z-index: 2147483647; }
  button { display: block; writing-mode: vertical-rl; rotate: 180deg; background: #183b4b; color: #fff;
    border: 0; border-radius: 0 8px 8px 0; padding: 14px 8px; font-family: inherit; font-size: 12px;
    font-weight: 600; line-height: 1.2; letter-spacing: .5px; box-shadow: 0 4px 14px #152d4233; cursor: pointer; }
  button:hover { background: #244f63; padding-right: 11px; }
  button:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
  button:disabled { opacity: .6; cursor: progress; }
  @media print { :host { display: none; } }`;

function feedbackEdgeButton() {
  return document.querySelector('[data-feedback-open]')?.shadowRoot?.querySelector('button') || null;
}

function feedbackIsModal(dialog) {
  try {
    return dialog.isConnected && dialog.open && dialog.matches(':modal');
  } catch {
    return false;
  }
}

// Open modal windows, the last one on top.
function feedbackOpenModals() {
  return (feedbackEdge.modals = feedbackEdge.modals.filter(feedbackIsModal));
}

function raiseFeedbackEdge() {
  const host = feedbackEdge.host;
  if (!host?.isConnected || typeof host.showPopover !== 'function') return;
  try {
    if (host.matches(':popover-open')) {
      // Hiding it would take the keyboard focus away from someone on the tab.
      if (host.matches(':focus-within')) return;
      host.hidePopover();
    }
    host.showPopover();
  } catch {
    /* without popovers the tab stays a fixed element with the highest z-index */
  }
}

function placeFeedbackEdge(raise) {
  const host = feedbackEdge.host;
  if (!host) return;
  const top = feedbackOpenModals().at(-1);
  // The feedback window itself covers the tab until it closes.
  if (top?.id === 'feedbackDialog') return;
  const parent = top || document?.body;
  if (!parent) return; // the page is being torn down
  if (host.parentNode !== parent) {
    parent.append(host);
    raise = true;
  }
  if (raise) raiseFeedbackEdge();
}

function watchFeedbackLayers() {
  if (feedbackEdge.watching) return;
  feedbackEdge.watching = true;
  document.querySelectorAll('dialog').forEach((d) => feedbackIsModal(d) && feedbackEdge.modals.push(d));
  // Windows open and close through the `open` attribute; a window whose content is redrawn
  // drops the tab, which is put back.
  new MutationObserver((records) => {
    let raise = false;
    for (const { type, target } of records) {
      if (type !== 'attributes' || target.localName !== 'dialog') continue;
      feedbackEdge.modals = feedbackEdge.modals.filter((d) => d !== target);
      if (feedbackIsModal(target)) {
        feedbackEdge.modals.push(target);
        raise = true;
      }
    }
    placeFeedbackEdge(raise);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  // A popover shown later (a collection notice, the incoming call strip) would cover the tab.
  document.addEventListener(
    'toggle',
    (event) => {
      if (event.newState !== 'open' || event.target === feedbackEdge.host || feedbackEdge.raising) return;
      feedbackEdge.raising = true;
      queueMicrotask(() => {
        feedbackEdge.raising = false;
        placeFeedbackEdge(true);
      });
    },
    true,
  );
}

function setupFeedbackButton() {
  if (document.querySelector('[data-feedback-open]')) return;
  const host = document.createElement('han-feedback-edge');
  host.className = 'feedback-edge';
  host.dataset.feedbackOpen = '';
  host.attachShadow({ mode: 'open' }).innerHTML =
    `<style>${FEEDBACK_EDGE_CSS}</style>` +
    '<button type="button" title="Hata, öneri veya soru gönderin">Geri bildirim</button>';
  // Clicks on the button reach the host; a click while the screenshot is taken is ignored.
  host.addEventListener('click', () => openFeedback());
  if (typeof host.showPopover === 'function') host.setAttribute('popover', 'manual');
  feedbackEdge.host = host;
  watchFeedbackLayers();
  placeFeedbackEdge(true);
}

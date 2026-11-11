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
        el.id === 'feedbackDialog' || el.id === 'voipWebphone' || el.tagName === 'IFRAME',
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
  }
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
  const button = document.querySelector('[data-feedback-open]');
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

function setupFeedbackButton() {
  if (document.querySelector('[data-feedback-open]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.dataset.feedbackOpen = '';
  button.textContent = 'Geri bildirim';
  button.title = 'Hata, öneri veya soru gönderin';
  button.onclick = () => openFeedback();
  document.querySelector('.header-actions')?.prepend(button);
}

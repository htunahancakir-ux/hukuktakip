function termsEscape(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function termsDate(value) {
  return value
    ? new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(new Date(value))
    : '—';
}

function termsDocumentMarkup(doc) {
  const h = termsEscape;
  return `<div class="terms-document-meta">
    <span>Uygulama: <b>${h(new URL(doc.domain).hostname)}</b></span>
    <span>Veri sorumlusu: <b>${h(doc.controllerName)}</b></span>
    <span>Sürüm <b>${h(doc.version)}</b> · ${termsDate(doc.issuedAt)}</span>
    </div>
    ${doc.sections
      .map(
        (section, i) => `<section>
      <h3>${i + 1}. ${h(section.title)}</h3>
      ${section.highlight ? `<p class="terms-highlight"><strong>${h(section.highlight)}</strong></p>` : ''}
      <p>${h(section.text)}</p>
    </section>`,
      )
      .join('')}`;
}

function termsNoticeLink(notice) {
  return notice
    ? `<a data-terms-notice href="${termsEscape(notice.url)}" target="_blank" rel="noopener noreferrer">Çalışan Aydınlatma Metni (${termsEscape(notice.version)})</a>`
    : '';
}

function bindTermsNotice(root, notice) {
  if (notice)
    root.querySelector('[data-terms-notice]')?.addEventListener('click', () => {
      fetch('/api/employee-terms/notice-opened', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify({ version: notice.version, hash: notice.hash }),
      }).catch(() => {});
    });
}

async function enterWorkspace() {
  const status = authApi('/api/employee-terms/current');
  if (!status.required && !status.reminder) return launchApplication();
  showEmployeeTermsGate(status);
}

function showEmployeeTermsGate({ document: doc, required, reminder, acceptedAt, notice }) {
  const gate = document.createElement('main');
  gate.id = 'employeeTermsGate';
  gate.innerHTML = `<form class="panel terms-gate" aria-labelledby="termsHeading">
    <div class="terms-gate-head"><div><p class="terms-kicker">Han Hukuk Takip · ${termsEscape(new URL(doc.domain).hostname)}</p>
    <h1 id="termsHeading">${termsEscape(doc.title)}</h1></div>
    <button type="button" class="secondary" data-terms-logout>Çıkış</button></div>
    <div class="terms-intro">
      <p>${
        required
          ? '<strong>Kabul kaydı:</strong> Kabul ettiğinizde çalışan hesabınız, belge sürümü ve tarih ile saat kaydedilir. Bu kayıt Hesabım’da gösterilir.'
          : `Bu sürüm yeniden görüntülemeniz için iletildi. <strong>Kabul tarihiniz:</strong> ${termsDate(acceptedAt)}.`
      }</p>
      ${termsNoticeLink(notice)}
    </div>
    <article class="terms-reader" tabindex="0" aria-label="Gizlilik sözleşmesi metni">${termsDocumentMarkup(doc)}</article>
    <div class="terms-gate-footer">
      ${
        required
          ? `<label><input type="checkbox" name="accepted" required disabled> Metni okudum ve kurallara uymayı taahhüt ediyorum</label>
      <small id="termsScrollHelp" aria-live="polite">Kabul seçeneğini açmak için metnin sonuna kadar kaydırın.</small>`
          : ''
      }
      <p class="terms-error" role="alert"></p>
      <div class="terms-buttons">
        ${hanAuth.role === 'ceo' ? '<button type="button" class="secondary" data-terms-manage>Sözleşmeyi yönet</button>' : ''}
        <button type="submit" class="primary" ${required ? 'disabled' : ''}>${required ? 'Kabul et ve devam et' : 'Kapat ve devam et'}</button>
      </div>
    </div></form>`;
  document.getElementById('employeeTermsGate')?.remove();
  document.body.append(gate);
  const form = gate.querySelector('form');
  const reader = gate.querySelector('.terms-reader');
  const errorLabel = gate.querySelector('.terms-error');
  const checkbox = form.elements.accepted;
  const submit = form.querySelector('[type="submit"]');
  document.getElementById('authGate')?.remove();
  reader.focus();
  if (checkbox) {
    const unlock = () => {
      if (reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 3) {
        checkbox.disabled = false;
        gate.querySelector('#termsScrollHelp').textContent = 'Metnin sonuna ulaştınız.';
        reader.removeEventListener('scroll', unlock);
      }
    };
    reader.addEventListener('scroll', unlock, { passive: true });
    unlock();
    checkbox.onchange = () => {
      submit.disabled = !checkbox.checked;
    };
  }
  bindTermsNotice(gate, notice);
  gate.querySelector('[data-terms-logout]').onclick = () => {
    try {
      authApi('/api/logout', 'POST', {});
      location.reload();
    } catch (error) {
      errorLabel.textContent = error.message;
    }
  };
  gate.querySelector('[data-terms-manage]')?.addEventListener('click', () => {
    try {
      const dialog = termsDialog('Gizlilik Sözleşmesi');
      renderEmployeeTermsManagement(dialog.querySelector('.terms-dialog-content'), { records: false });
      dialog.showModal();
    } catch (error) {
      errorLabel.textContent = error.message;
    }
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (required && (!checkbox.checked || checkbox.disabled)) return;
    submit.disabled = true;
    const payload = { version: doc.version, hash: doc.hash };
    try {
      if (required) authApi('/api/employee-terms/accept', 'POST', { ...payload, accepted: true });
      else authApi('/api/employee-terms/reminder-seen', 'POST', { ...payload, sentAt: reminder });
      location.reload();
    } catch (error) {
      errorLabel.textContent = error.message;
      submit.disabled = false;
    }
  };
}

function termsDialog(title) {
  const dialog = document.createElement('dialog');
  dialog.className = 'terms-dialog';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<div class="panelhead"><h2>${termsEscape(title)}</h2>
    <button type="button" class="secondary" data-terms-close>Kapat</button></div>
    <div class="formbody terms-dialog-content"></div>`;
  dialog.querySelector('[data-terms-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  return dialog;
}

function showMyEmployeeTerms() {
  const dialog = termsDialog('Hesabım · Sözleşme geçmişi');
  const content = dialog.querySelector('.terms-dialog-content');
  const render = () => {
    try {
      const { items, notice } = authApi('/api/employee-terms/history');
      content.innerHTML = `<p><strong>${termsEscape(hanAuth.name)}</strong> · ${termsEscape(hanAuth.username)}</p>
        ${termsNoticeLink(notice)}
        ${
          items.length
            ? `<ul class="terms-history">${items
                .map(
                  (item) => `<li>
          <div><strong>Sürüm ${termsEscape(item.version)}</strong><br>Kabul: ${termsDate(item.acceptedAt)}</div>
          <button type="button" class="secondary" data-terms-version="${termsEscape(item.version)}">Belgeyi görüntüle</button></li>`,
                )
                .join('')}</ul>`
            : '<p>Henüz kabul edilmiş sözleşme kaydınız yok.</p>'
        }`;
      bindTermsNotice(content, notice);
      content.querySelectorAll('[data-terms-version]').forEach((button) => {
        button.onclick = () => {
          try {
            const { document: doc, record } = authApi(
              '/api/employee-terms/history?version=' + encodeURIComponent(button.dataset.termsVersion),
            );
            content.innerHTML = `<button type="button" class="secondary" data-terms-back>Geçmişe dön</button>
              <h3>${termsEscape(doc.title)}</h3><p>Kabul: <strong>${termsDate(record.acceptedAt)}</strong></p>
              <article class="terms-reader" tabindex="0" aria-label="Kabul edilen sözleşme">${termsDocumentMarkup(doc)}</article>`;
            content.querySelector('[data-terms-back]').onclick = render;
            content.querySelector('.terms-reader').focus();
          } catch (error) {
            button.insertAdjacentText('afterend', error.message);
          }
        };
      });
    } catch (error) {
      content.textContent = error.message;
    }
  };
  render();
  dialog.showModal();
}

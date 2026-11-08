function employeeTermsSettingsPage() {
  const content = document.getElementById('content');
  content.innerHTML = settingsSectionTabs('employeeTerms') + '<div id="employeeTermsSettings"></div>';
  bindSettingsSectionTabs();
  renderEmployeeTermsManagement(document.getElementById('employeeTermsSettings'));
}

function renderEmployeeTermsManagement(root, { records = true } = {}) {
  const h = termsEscape;
  const isCEO = hanAuth.role === 'ceo';
  root.innerHTML =
    '<section class="panel"><div class="panelhead"><div><h2>Gizlilik Sözleşmesi</h2><p>Sürümleri yayınlayın ve çalışanların kabul kayıtlarını inceleyin.</p></div></div><div class="formbody terms-settings"></div></section>';
  const body = root.querySelector('.terms-settings');
  if (isCEO) {
    try {
      const { document: doc, draft, notice, users } = authApi('/api/employee-terms/settings');
      body.innerHTML = `<p>${doc ? `<strong>Yayındaki sürüm: ${h(doc.version)}</strong> · ${termsDate(doc.issuedAt)}` : 'Henüz yayınlanmış sözleşme yok.'}</p>
        <div><button type="button" class="secondary" data-terms-preview>Kullanıcı ekranını önizle</button></div>
        <details class="terms-settings-group" ${doc ? '' : 'open'}>
          <summary>Metni ve veri sorumlusunu düzenle</summary>
          <form data-terms-publish class="terms-settings-form">
            <p>Yeni sürümü yayınladığınızda tüm etkin hesaplar güncel belgeyi tekrar kabul eder. Eski belgeler ve kabul kayıtları korunur.</p>
            <div class="grid">
              <label class="field">Yeni sürüm<input name="version" required maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,39}" placeholder="Örn. 1.3.1" value="${doc ? '' : '1.3.0'}"></label>
              <label class="field">Veri sorumlusu<input name="controllerName" value="${h(draft.controllerName)}" required maxlength="180"></label>
            </div>
            <div data-terms-sections></div>
            <div class="terms-buttons">
              <button type="button" class="secondary" data-terms-add>Bölüm ekle</button>
              <button type="submit" class="primary">Yeni sürümü yayınla</button>
            </div>
            <div class="terms-publish-confirm" data-terms-confirm hidden tabindex="-1" aria-label="Sözleşme yayın onayı">
              <p data-terms-confirm-summary></p>
              <p>Mevcut ve yeni kullanıcılar bu belgeyi kabul etmeden çalışma alanına geçemez. Önceki belgeler ve kabul kayıtları korunur.</p>
              <div class="terms-buttons">
                <button type="button" class="secondary" data-terms-cancel>Vazgeç</button>
                <button type="button" class="primary" data-terms-confirm-publish>Onayla ve yayınla</button>
              </div>
            </div><p role="status" aria-live="polite" data-terms-status></p>
          </form>
        </details>
        ${
          doc
            ? `<details class="terms-settings-group"><summary>Güncel belgeyi tekrar göster</summary>
          <form data-terms-resend class="terms-settings-form">
            <p>Belge sonraki girişte veya sayfa yenilenince görünür. Bu sürümü kabul etmiş kullanıcılar yeniden kabul vermez.</p>
            <label class="field">Alıcı<select name="recipient"><option value="all">Tüm etkin kullanıcılar</option>
              ${users
                .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
                .map((user) => `<option value="${h(user.id)}">${h(user.name)} (${h(user.username)})</option>`)
                .join('')}</select></label>
            <div><button type="submit" class="primary">Tekrar göster</button></div><p role="status" data-terms-status></p>
          </form></details>`
            : ''
        }
        <details class="terms-settings-group"><summary>Çalışan aydınlatma bağlantısı (isteğe bağlı)</summary>
          <form data-terms-notice-form class="terms-settings-form">
            <p>Bu bağlantının açılması ayrı kaydedilir. Sözleşme kabulü veya açık rıza olarak kullanılmaz.</p>
            <div class="grid">
              <label class="field">Aydınlatma sürümü<input name="version" maxlength="40" required value="${h(notice?.version)}"></label>
              <label class="field">HTTPS bağlantısı<input name="url" type="url" required maxlength="1000" value="${h(notice?.url)}"></label>
            </div>
            <div class="terms-buttons"><button type="submit" class="primary">Bağlantıyı kaydet</button>
              ${notice ? '<button type="button" class="secondary" data-terms-remove-notice>Bağlantıyı kaldır</button>' : ''}</div>
            <p role="status" data-terms-status></p>
          </form>
        </details>`;
      const publish = body.querySelector('[data-terms-publish]');
      const sectionRoot = publish.querySelector('[data-terms-sections]');
      const addSection = (section = {}) => {
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'terms-editor-section';
        fieldset.innerHTML = `<label class="field">Bölüm başlığı<input data-title value="${h(section.title)}" required maxlength="150"></label>
          <label class="field">Vurgu <textarea data-highlight rows="2" maxlength="2000">${h(section.highlight)}</textarea></label>
          <label class="field">Bölüm metni<textarea data-text rows="3" required maxlength="5000">${h(section.text)}</textarea></label>
          <button type="button" class="secondary" data-remove>Bölümü kaldır</button>`;
        sectionRoot.append(fieldset);
        fieldset.querySelector('[data-remove]').onclick = () => {
          if (sectionRoot.childElementCount > 1) {
            fieldset.remove();
            publish.dataset.modalDirty = 'true';
          }
        };
        return fieldset;
      };
      draft.sections.forEach(addSection);
      publish.querySelector('[data-terms-add]').onclick = () => {
        if (sectionRoot.childElementCount < 20) {
          addSection().querySelector('input').focus();
          publish.dataset.modalDirty = 'true';
        }
      };
      const update = (form, data, onSuccess) => {
        const status = form.querySelector('[data-terms-status]');
        status.textContent = '';
        try {
          onSuccess(authApi('/api/employee-terms/settings', 'PUT', data));
        } catch (error) {
          status.textContent = error.message;
        }
      };
      const confirmation = publish.querySelector('[data-terms-confirm]');
      const publishStatus = publish.querySelector('[data-terms-status]');
      const confirmButton = publish.querySelector('[data-terms-confirm-publish]');
      let pendingPublication = null;
      let publishing = false;
      const publicationData = () => ({
        action: 'publish',
        baseVersion: doc?.version || null,
        version: publish.elements.version.value.trim(),
        controllerName: publish.elements.controllerName.value.trim(),
        sections: Array.from(sectionRoot.children, (row) => ({
          title: row.querySelector('[data-title]').value,
          text: row.querySelector('[data-text]').value,
          highlight: row.querySelector('[data-highlight]').value,
        })),
      });
      body.querySelector('[data-terms-preview]').onclick = () => {
        const input = publicationData();
        showEmployeeTermsPreview(
          {
            ...input,
            version: input.version || doc?.version || 'Taslak',
            title: doc?.title || 'Çalışanlar İçin Gizlilik ve Kişisel Veri Güvenliği Sözleşmesi',
            domain: doc?.domain || 'https://www.hanhukuktakip.com',
            issuedAt: doc?.issuedAt || null,
          },
          notice,
        );
      };
      publish.addEventListener(
        'invalid',
        () => {
          publishStatus.textContent = 'Yayınlanamadı. İşaretlenen eksik veya hatalı alanı düzeltin.';
          publishStatus.classList.add('terms-error');
          confirmation.hidden = true;
          pendingPublication = null;
        },
        true,
      );
      publish.onsubmit = (event) => {
        event.preventDefault();
        if (publishing || !publish.reportValidity()) return;
        pendingPublication = publicationData();
        confirmation.querySelector('[data-terms-confirm-summary]').textContent =
          'Sürüm ' +
          pendingPublication.version +
          ' · Veri sorumlusu: ' +
          pendingPublication.controllerName +
          ' · ' +
          users.length +
          ' etkin hesap için yayınlanacak.';
        publishStatus.textContent = '';
        publishStatus.classList.remove('terms-error');
        confirmation.hidden = false;
        confirmation.scrollIntoView({ block: 'nearest' });
        confirmButton.focus();
      };
      publish.querySelector('[data-terms-cancel]').onclick = () => {
        confirmation.hidden = true;
        pendingPublication = null;
        publish.querySelector('[type="submit"]').focus();
      };
      confirmButton.onclick = async () => {
        if (publishing || !pendingPublication || !publish.reportValidity()) return;
        if (JSON.stringify(pendingPublication) !== JSON.stringify(publicationData())) {
          pendingPublication = null;
          confirmation.hidden = true;
          publishStatus.textContent =
            'Metin değişti. Yeni sürümü yayınla düğmesine basıp güncel bilgileri onaylayın.';
          return;
        }
        publishing = true;
        const controls = Array.from(publish.elements, (el) => [el, el.disabled]);
        controls.forEach(([el]) => {
          el.disabled = true;
        });
        publishStatus.classList.remove('terms-error');
        publishStatus.textContent = 'Sözleşme yayınlanıyor…';
        try {
          const response = await fetch('/api/employee-terms/settings', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
            body: JSON.stringify(pendingPublication),
          });
          const result = await response.json();
          if (response.status === 401)
            throw Error(
              'Oturumunuz sona erdi. Metniniz bu sayfada korunuyor. Başka sekmede tekrar giriş yapıp burada yeniden deneyin.',
            );
          if (!response.ok) throw Error(result.error || 'Sözleşme yayınlanamadı.');
          if (result.document?.version !== pendingPublication.version)
            throw Error('Yayın sonucu doğrulanamadı. Sayfayı yenileyip yayındaki sürümü kontrol edin.');
          if (typeof modalFormSaved === 'function') modalFormSaved(publish);
          publishStatus.textContent =
            'Sürüm ' + result.document.version + ' yayınlandı. Kabul ekranı açılıyor…';
          location.reload();
        } catch (error) {
          publishing = false;
          controls.forEach(([el, disabled]) => {
            el.disabled = disabled;
          });
          publishStatus.classList.add('terms-error');
          publishStatus.textContent = error.message || 'Bağlantı kurulamadı. Lütfen tekrar deneyin.';
          publishStatus.scrollIntoView({ block: 'nearest' });
        }
      };
      const resend = body.querySelector('[data-terms-resend]');
      if (resend)
        resend.onsubmit = (event) => {
          event.preventDefault();
          update(
            resend,
            { action: 'resend', version: doc.version, recipient: resend.elements.recipient.value },
            ({ recipients }) => {
              resend.querySelector('[data-terms-status]').textContent = recipients + ' hesaba gösterilecek.';
              resend.elements.recipient.selectedIndex = 0;
            },
          );
        };
      const noticeForm = body.querySelector('[data-terms-notice-form]');
      noticeForm.onsubmit = (event) => {
        event.preventDefault();
        update(
          noticeForm,
          {
            action: 'notice',
            version: noticeForm.elements.version.value,
            url: noticeForm.elements.url.value,
          },
          () => renderEmployeeTermsManagement(root, { records }),
        );
      };
      noticeForm.querySelector('[data-terms-remove-notice]')?.addEventListener('click', () => {
        update(noticeForm, { action: 'notice', enabled: false }, () =>
          renderEmployeeTermsManagement(root, { records }),
        );
      });
    } catch (error) {
      body.textContent = error.message;
    }
  }
  if (records) {
    const list = document.createElement('div');
    body.append(list);
    renderEmployeeTermsRecords(list);
  }
}

function renderEmployeeTermsRecords(root) {
  const h = termsEscape;
  function render(selectedVersion) {
    try {
      const { versions, items } = authApi(
        '/api/employee-terms/records' +
          (selectedVersion ? '?version=' + encodeURIComponent(selectedVersion) : ''),
      );
      root.innerHTML = `<h3>Kabul kayıtları</h3>
        ${
          versions.length
            ? `<label class="field">Belge sürümü<select data-terms-records>${versions
                .map(
                  (doc) =>
                    `<option value="${h(doc.version)}" ${doc.version === selectedVersion ? 'selected' : ''}>${h(doc.version)} · ${termsDate(doc.issuedAt)}</option>`,
                )
                .join('')}</select></label>`
            : ''
        }
        ${
          items.length
            ? `<ul class="terms-history">${items
                .map(
                  (item) =>
                    `<li><div><strong>${h(item.name)}</strong> · ${h(item.username)}</div><time datetime="${h(item.acceptedAt)}">${termsDate(item.acceptedAt)}</time></li>`,
                )
                .join('')}</ul>`
            : '<p>Bu sürüm için henüz kabul kaydı yok.</p>'
        }`;
      const filter = root.querySelector('[data-terms-records]');
      if (filter) filter.onchange = () => render(filter.value);
    } catch (error) {
      root.textContent = error.message;
    }
  }
  render();
}

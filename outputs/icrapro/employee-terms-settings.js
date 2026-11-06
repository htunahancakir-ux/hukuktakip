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
            </div><p role="status" data-terms-status></p>
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
      publish.onsubmit = (event) => {
        event.preventDefault();
        if (
          !window.confirm(
            'Yeni sürüm yayınlansın mı? Tüm kullanıcılar sonraki girişte veya yenilemede güncel metni kabul edecek.',
          )
        )
          return;
        update(
          publish,
          {
            action: 'publish',
            baseVersion: doc?.version || null,
            version: publish.elements.version.value,
            controllerName: publish.elements.controllerName.value,
            sections: Array.from(sectionRoot.children, (row) => ({
              title: row.querySelector('[data-title]').value,
              text: row.querySelector('[data-text]').value,
              highlight: row.querySelector('[data-highlight]').value,
            })),
          },
          () => location.reload(),
        );
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

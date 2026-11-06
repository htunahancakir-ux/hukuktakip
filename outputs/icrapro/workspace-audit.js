const auditCategories = {
  changes: 'Kayıt işlemleri',
  login: 'Girişler',
  logout: 'Çıkışlar',
  failed: 'Hatalı girişler',
};
const auditActions = {
  create: 'Ekledi',
  update: 'Düzenledi',
  delete: 'Sildi',
  download: 'İndirdi',
  backup: 'Yedek aldı',
  restore: 'Arşivden çıkardı',
  whatsapp: 'WhatsApp gönderdi',
  accept: 'Sözleşmeyi kabul etti',
  publish: 'Sözleşmeyi yayınladı',
  resend: 'Sözleşmeyi tekrar gösterdi',
  login: 'Giriş yaptı',
  logout: 'Çıkış yaptı',
  failed: 'Giriş başarısız',
  blocked: 'Deneme sınırına ulaştı',
};

function userAuditTabs(active) {
  return `<div class="settings-tabs" role="tablist" aria-label="Kullanıcı yönetimi sekmeleri">
    <button type="button" role="tab" id="userAccountsTab" aria-selected="${active === 'users'}" class="${active === 'users' ? 'selected' : ''}">Kullanıcılar</button>
    <button type="button" role="tab" id="userAuditTab" aria-selected="${active === 'audit'}" class="${active === 'audit' ? 'selected' : ''}">İşlem Kayıtları</button>
  </div>`;
}

function bindUserAuditTabs() {
  $('#userAccountsTab').onclick = () => userManagement();
  $('#userAuditTab').onclick = () => auditSettingsPage('users');
}

function auditSettingsPage(source = 'settings') {
  $('#content').innerHTML = `${source === 'users' ? userAuditTabs('audit') : settingsSectionTabs('audit')}
    <section class="panel audit-panel" aria-labelledby="auditTitle">
      <div class="panelhead"><div><h2 id="auditTitle">İşlem Kayıtları</h2>
        <p>İşlemleri yapan hesabı, ilgili bölümü ve zamanı inceleyin.</p></div></div>
      <div class="audit-tabs" role="group" aria-label="Kayıt türü">${Object.entries(auditCategories)
        .map(
          ([key, label]) =>
            `<button type="button" data-audit-category="${key}" aria-pressed="${key === 'changes'}">${label}</button>`,
        )
        .join('')}</div>
      <form class="audit-filters" id="auditFilters">
        <label class="field">Kullanıcı<input name="actor" type="search" maxlength="80" placeholder="Ad veya kullanıcı adı"></label>
        <label class="field">Başlangıç<input name="from" type="date" data-optional="true"></label>
        <label class="field">Bitiş<input name="to" type="date" data-optional="true"></label>
        <label class="field" id="auditActionField">İşlem<select name="action" data-optional="true"><option value="">Tümü</option>${Object.entries(
          auditActions,
        )
          .filter(([key]) => !['login', 'logout', 'failed', 'blocked'].includes(key))
          .map(([key, label]) => `<option value="${key}">${label}</option>`)
          .join('')}</select></label>
        <button class="primary" type="submit">Filtrele</button>
        <button class="secondary" type="reset">Temizle</button>
      </form>
      <div class="audit-results" id="auditResults" aria-live="polite"></div>
      <div class="actions audit-pages">
        <button type="button" class="secondary" id="auditPrev" disabled>Daha yeni</button>
        <button type="button" class="secondary" id="auditNext" disabled>Daha eski</button>
      </div>
    </section>`;
  if (source === 'users') bindUserAuditTabs();
  else bindSettingsSectionTabs();
  const form = $('#auditFilters');
  const results = $('#auditResults');
  const prev = $('#auditPrev');
  const next = $('#auditNext');
  let category = 'changes';
  let cursors = [''];
  let nextCursor = null;
  let requestId = 0;
  let applied = new URLSearchParams();

  function showRows(items) {
    if (!items.length) {
      results.textContent = 'Bu filtrelerle eşleşen kayıt bulunamadı.';
      return;
    }
    results.innerHTML = `<div class="overflow"><table class="audit-table"><thead><tr>
      <th>Tarih ve saat</th><th>Kullanıcı</th><th>İşlem</th><th>Bölüm / Kayıt</th></tr></thead><tbody>${items
        .map((row) => {
          const actor = row.actor_name || row.actor_username;
          const label = auditActions[row.action] || row.action;
          return `<tr><td class="audit-time"><time datetime="${esc(row.at)}">${backupDate(row.at, true)}</time></td>
          <td><strong>${esc(actor || 'Tanımlanamayan hesap')}</strong>${
            actor && row.actor_username && actor !== row.actor_username
              ? `<small>${esc(row.actor_username)}</small>`
              : ''
          }</td>
          <td><span class="audit-action" data-tone="${row.category === 'failed' || row.action === 'delete' ? 'alert' : 'neutral'}">${esc(label)}</span></td>
          <td><strong>${esc(row.area)}</strong>${row.record_ref ? `<small>${esc(row.record_ref)}</small>` : ''}
          ${row.fields.length ? `<small>${row.fields.map(esc).join(', ')}</small>` : ''}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  async function load() {
    const id = ++requestId;
    const query = new URLSearchParams(applied);
    query.set('category', category);
    if (category !== 'changes') query.delete('action');
    if (cursors.at(-1)) query.set('cursor', cursors.at(-1));
    results.textContent = 'Kayıtlar yükleniyor…';
    prev.disabled = next.disabled = true;
    try {
      const response = await fetch('/api/audit?' + query, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'İşlem kayıtları yüklenemedi.');
      if (id !== requestId || !results.isConnected) return;
      showRows(data.items);
      nextCursor = data.next;
      next.disabled = !nextCursor;
    } catch (error) {
      if (id === requestId && results.isConnected) results.textContent = error.message;
    } finally {
      if (id === requestId) prev.disabled = cursors.length <= 1;
    }
  }
  const resetPage = () => {
    cursors = [''];
    load();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    applied = new URLSearchParams(new FormData(form));
    resetPage();
  };
  form.onreset = () => {
    applied = new URLSearchParams();
    resetPage();
  };
  document.querySelectorAll('[data-audit-category]').forEach((button) => {
    button.onclick = () => {
      category = button.dataset.auditCategory;
      document
        .querySelectorAll('[data-audit-category]')
        .forEach((item) => item.setAttribute('aria-pressed', item === button));
      $('#auditActionField').hidden = category !== 'changes';
      resetPage();
    };
  });
  prev.onclick = () => {
    if (cursors.length > 1) {
      cursors.pop();
      load();
    }
  };
  next.onclick = () => {
    if (nextCursor) {
      cursors.push(nextCursor);
      load();
    }
  };
  load();
}

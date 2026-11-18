function bindExcelImportButtons(currentPage) {
  document.getElementById('excelImportClients')?.remove();
  document.getElementById('excelImportDocuments')?.remove();
  if (
    !['clients', 'intake'].includes(currentPage) ||
    hanAuth.platformSupport ||
    (hanAuth.readOnly && hanAuth.role !== 'ceo')
  )
    return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  const kind = currentPage === 'clients' ? 'clients' : 'documents';
  if (window.hanModuleAction?.(kind, 'create') === false) return;
  button.id = kind === 'clients' ? 'excelImportClients' : 'excelImportDocuments';
  button.textContent = kind === 'clients' ? 'Excel’den Müvekkil Aktar' : 'Excel’den Borçlu Aktar';
  button.style.marginLeft = 'auto';
  button.onclick = () => openExcelImport(kind);
  document.getElementById('newClient').before(button);
}

async function openExcelImport(kind) {
  const dialog = document.getElementById('modal'),
    title = kind === 'clients' ? 'Excel’den Müvekkil Aktar' : 'Excel’den Borçlu Aktar';
  const previousClass = dialog.className;
  dialog.classList.add('excel-import-dialog');
  dialog.innerHTML =
    '<div class="panelhead"><div><h2>' +
    esc(title) +
    '</h2><p>Dosyayı seçin, sütunları kontrol edin ve aktarılacak kayıtları işaretleyin.</p></div><button type="button" class="secondary" data-excel-close>Kapat</button></div><div class="formbody" data-excel-loading>Aktarım hazırlanıyor…</div>';
  dialog.querySelector('[data-excel-close]').onclick = () => dialog.close();
  dialog.addEventListener(
    'close',
    () => {
      dialog.className = previousClass;
    },
    { once: true },
  );
  if (!dialog.open) dialog.showModal();
  const loading = dialog.querySelector('[data-excel-loading]');
  const request = async (path, input, signal) => {
    const response = await fetch('/api/excel-import/' + path, {
      method: input ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1', ...(input ? { 'Content-Type': 'application/json' } : {}) },
      body: input ? JSON.stringify(input) : undefined,
      signal,
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Excel aktarımı yapılamadı.');
    return result;
  };
  let options;
  try {
    options = await request('options?kind=' + kind);
  } catch (error) {
    if (loading.isConnected) loading.textContent = error.message;
    return;
  }
  if (!loading.isConnected || !dialog.open) return;
  const option = (value, label) => '<option value="' + esc(value) + '">' + esc(label) + '</option>';
  loading.outerHTML =
    '<form id="excelImportForm"><div class="formbody grid excel-import-controls">' +
    '<label class="field">Excel dosyası (.xlsx)<input type="file" name="workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-optional="true"><small>En fazla 2 MB ve 500 veri satırı. Dosyanın kendisi saklanmaz.</small></label>' +
    '<div class="field"><span>Örnek dosya</span><a class="secondary" href="/api/excel-import/template?kind=' +
    kind +
    '" download>Excel Şablonu İndir</a></div>' +
    '<label class="field">Excel sayfası<select name="sheet" data-optional="true" disabled><option value="">Önce dosya seçin</option></select></label>' +
    (kind === 'clients'
      ? '<label class="field">Excel’de boşsa müvekkil türü<select name="category" data-optional="true">' +
        options.categories.map((c) => option(c, c)).join('') +
        '</select></label><label class="settings-check full"><input type="checkbox" name="mergeSheets" data-optional="true" checked> Diğer sayfalardaki aynı müvekkil kodu ve adına ait bilgileri birleştir</label>'
      : '<label class="field">Excel’de müvekkil yoksa kullanılacak müvekkil<input type="search" data-excel-client-query data-optional="true" placeholder="Müvekkil ara…"><select name="clientId" data-optional="true"><option value="">Excel’deki müvekkili eşleştir</option></select><small data-excel-client-count></small></label>' +
        '<label class="field">Excel’de boşsa evrak türü<select name="docType" data-optional="true">' +
        options.docTypes.map((t) => option(t, t)).join('') +
        '</select></label>' +
        '<label class="field">Excel’de boşsa evrakı alan personel<select name="receivedBy" data-optional="true">' +
        option('', 'Belirtilmedi') +
        option('receiver:han', 'HAN') +
        options.staff.map((s) => option(s.id, s.name)).join('') +
        '</select></label>' +
        '<label class="field">Excel’de boşsa kayıt tarihi<input type="date" name="registrationDate" data-optional="true" value="' +
        esc(businessDate()) +
        '"></label>' +
        '<label class="field">Excel’de boşsa vade tarihi<input type="date" name="dueDate" data-optional="true"></label>' +
        '<label class="settings-check full"><input type="checkbox" name="includeHistoricalPayments" data-optional="true" checked> Geçmiş tahsilatları da aktar; kasa / banka bakiyesine işleme</label>' +
        '<label class="settings-check full"><input type="checkbox" name="autoCharges" data-optional="true"> Excel’de faiz ve avukatlık ücreti yoksa otomatik hesapla</label>' +
        '<p class="notice full">Aynı kaynak föy numarasındaki evraklar tek föyde toplanır. Kaynak numarası yoksa aynı müvekkil, TC/vergi no ve borçlu adına ait satırlar birleştirilir. Yeni föy numarası sistem tarafından atanır. Mevcut föylere otomatik evrak eklenmez.</p>') +
    '</div><details class="excel-import-mapping" hidden><summary>Sütunları eşleştir</summary><div class="formbody grid" data-excel-mapping></div></details><div class="formbody" data-excel-status role="status" aria-live="polite">Dosya seçildiğinde kayıt önizlemesi açılır.</div><div data-excel-preview></div><div class="actions"><button type="button" class="secondary" data-excel-recheck disabled>Önizlemeyi Güncelle</button><button type="button" class="primary" data-excel-commit disabled>Seçilen Kayıtları Aktar</button></div></form>';
  const form = document.getElementById('excelImportForm'),
    status = form.querySelector('[data-excel-status]'),
    preview = form.querySelector('[data-excel-preview]'),
    commitButton = form.querySelector('[data-excel-commit]'),
    recheck = form.querySelector('[data-excel-recheck]');
  const state = {
    file: null,
    request: null,
    version: 0,
    readVersion: 0,
    valid: false,
    items: [],
    selected: new Set(),
    index: 0,
    committing: false,
  };
  form.onsubmit = (event) => event.preventDefault();
  if (kind === 'clients') form.elements.category.value = 'Diğer';
  else {
    form.elements.docType.value = 'Senet';
    const select = form.elements.clientId;
    if (typeof setIntakeClientOption === 'function' && selected) setIntakeClientOption(select, selected);
    if (typeof bindIntakeClientSelect === 'function')
      bindIntakeClientSelect(
        form.querySelector('[data-excel-client-query]'),
        select,
        'Excel’deki müvekkili eşleştir',
        form.querySelector('[data-excel-client-count]'),
      );
  }
  dialog.addEventListener(
    'close',
    () => {
      if (!state.committing) state.request?.abort();
      form.elements.clientId?._intakeClientRequest?.abort();
    },
    { once: true },
  );
  function input() {
    const body = { kind, ...state.file };
    for (const name of [
      'category',
      'clientId',
      'docType',
      'receivedBy',
      'registrationDate',
      'dueDate',
      'sheet',
    ])
      if (form.elements[name]) body[name] = form.elements[name].value;
    for (const name of ['mergeSheets', 'includeHistoricalPayments', 'autoCharges'])
      if (form.elements[name]) body[name] = form.elements[name].checked;
    const controls = [...form.querySelectorAll('[data-excel-field]')];
    if (controls.length)
      body.mapping = Object.fromEntries(controls.map((c) => [c.dataset.excelField, c.value]));
    return body;
  }
  function selectionSummary() {
    const count = state.selected.size;
    commitButton.disabled = state.committing || !state.valid || !count;
    commitButton.textContent = count ? 'Seçilen ' + count + ' Kaydı Aktar' : 'Seçilen Kayıtları Aktar';
  }
  function paintRows() {
    const rows = state.items.slice(state.index * 50, (state.index + 1) * 50);
    preview.innerHTML =
      '<div class="overflow"><table><thead><tr><th><input type="checkbox" data-excel-all aria-label="Aktarılabilir kayıtların tümünü seç" data-optional="true"></th><th>Kaynak</th><th>Ad / Unvan</th><th>' +
      (kind === 'clients' ? 'Müvekkil Türü' : 'Müvekkil / Evrak') +
      '</th><th>Durum</th><th>Açıklama</th></tr></thead><tbody>' +
      rows
        .map(
          (row) =>
            '<tr class="excel-row-' +
            esc(row.state) +
            '"><td><input type="checkbox" data-excel-row="' +
            esc(row.key) +
            '" data-optional="true" aria-label="' +
            esc(row.label) +
            ' seç" ' +
            (row.state === 'ready' ? '' : 'disabled') +
            ' ' +
            (state.selected.has(row.key) ? 'checked' : '') +
            '></td><td>' +
            esc(row.sources.map((s) => s.sheet + ' · ' + s.row).join(', ')) +
            '</td><td>' +
            esc(row.label || '—') +
            '</td><td>' +
            esc(row.detail) +
            (row.docType ? '<small>' + esc(row.docType) + '</small>' : '') +
            '</td><td>' +
            ({ ready: 'Aktarılabilir', duplicate: 'Zaten kayıtlı', error: 'Düzeltilmeli' }[row.state] || '') +
            '</td><td>' +
            esc(row.message || '') +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table></div><div class="tablefoot"><span>' +
      state.items.length +
      ' kayıt · ' +
      (state.index * 50 + 1) +
      '–' +
      Math.min((state.index + 1) * 50, state.items.length) +
      '</span><div class="toolbar"><button type="button" class="secondary" data-excel-previous ' +
      (state.index ? '' : 'disabled') +
      '>Önceki</button><button type="button" class="secondary" data-excel-next ' +
      ((state.index + 1) * 50 < state.items.length ? '' : 'disabled') +
      '>Sonraki</button></div></div>';
    const all = preview.querySelector('[data-excel-all]'),
      ready = state.items.filter((r) => r.state === 'ready');
    all.checked = ready.length > 0 && ready.every((r) => state.selected.has(r.key));
    all.disabled = !ready.length;
    all.onchange = () => {
      state.selected = all.checked ? new Set(ready.map((r) => r.key)) : new Set();
      paintRows();
    };
    for (const c of preview.querySelectorAll('[data-excel-row]'))
      c.onchange = () => {
        if (c.checked) state.selected.add(c.dataset.excelRow);
        else state.selected.delete(c.dataset.excelRow);
        selectionSummary();
      };
    preview.querySelector('[data-excel-previous]').onclick = () => {
      state.index--;
      paintRows();
    };
    preview.querySelector('[data-excel-next]').onclick = () => {
      state.index++;
      paintRows();
    };
    selectionSummary();
  }
  async function refresh(resetMapping = false) {
    if (!state.file || state.committing) return;
    state.valid = false;
    state.request?.abort();
    const controller = new AbortController(),
      version = ++state.version;
    state.request = controller;
    commitButton.disabled = true;
    recheck.disabled = true;
    status.textContent = 'Excel ve mevcut kayıtlar kontrol ediliyor…';
    const body = input();
    if (resetMapping) delete body.mapping;
    try {
      const result = await request('preview', body, controller.signal);
      if (!form.isConnected || version !== state.version || !dialog.open) return;
      const select = form.elements.sheet;
      select.innerHTML = result.sheets
        .map((s) => option(s.name, s.name + ' (' + s.rowCount + ' satır)'))
        .join('');
      select.value = result.sheet;
      select.disabled = false;
      const description = result.sheets.find((s) => s.name === result.sheet),
        container = form.querySelector('[data-excel-mapping]');
      if (resetMapping || !container.children.length) {
        container.innerHTML = options.fields
          .map(
            (field) =>
              '<label class="field">' +
              esc(field.label) +
              '<select data-excel-field="' +
              esc(field.key) +
              '" data-optional="true">' +
              option('', 'Aktarma / Excel’de yok') +
              description.columns.map((c) => option(c.key, c.key + ' · ' + c.label)).join('') +
              '</select></label>',
          )
          .join('');
        for (const c of container.querySelectorAll('[data-excel-field]'))
          c.value = description.mapping[c.dataset.excelField] || '';
      }
      form.querySelector('.excel-import-mapping').hidden = false;
      for (const control of container.querySelectorAll('[data-excel-field]'))
        control.onchange = () => {
          state.valid = false;
          state.version++;
          state.request?.abort();
          recheck.disabled = false;
          selectionSummary();
          status.textContent = 'Sütun eşleştirmesi değişti. Aktarmadan önce önizlemeyi güncelleyin.';
        };
      if (result.totals.error) form.querySelector('.excel-import-mapping').open = true;
      state.valid = true;
      state.items = result.items;
      state.selected = new Set(result.items.filter((r) => r.state === 'ready').map((r) => r.key));
      state.index = 0;
      status.textContent =
        result.totals.ready +
        ' aktarılabilir · ' +
        result.totals.duplicate +
        ' zaten kayıtlı · ' +
        result.totals.error +
        ' düzeltilmeli. Yalnız işaretlenen kayıtlar aktarılır.';
      paintRows();
    } catch (error) {
      if (error.name !== 'AbortError' && form.isConnected) {
        state.items = [];
        state.selected.clear();
        preview.textContent = '';
        status.textContent = error.message;
        commitButton.disabled = true;
      }
    } finally {
      if (form.isConnected && version === state.version) recheck.disabled = !state.file;
    }
  }
  form.elements.workbook.onchange = async () => {
    const file = form.elements.workbook.files[0],
      readVersion = ++state.readVersion;
    state.valid = false;
    state.version++;
    state.request?.abort();
    state.file = null;
    state.selected.clear();
    commitButton.disabled = true;
    recheck.disabled = true;
    preview.textContent = '';
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name) || file.size > options.maxFileBytes) {
      status.textContent = 'En fazla 2 MB boyutunda .xlsx dosyası seçin.';
      return;
    }
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(Error('Dosya okunamadı.'));
        reader.readAsDataURL(file);
      });
      if (readVersion !== state.readVersion || !form.isConnected) return;
      state.file = { fileName: file.name, fileBase64: data };
      form.elements.sheet.value = '';
      await refresh(true);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  form.elements.sheet.onchange = () => refresh(true);
  recheck.onclick = () => refresh();
  for (const c of form.querySelectorAll(
    '.excel-import-controls select,.excel-import-controls input:not([type=file]):not([type=search])',
  ))
    if (c !== form.elements.sheet) c.addEventListener('change', () => refresh());
  commitButton.onclick = async () => {
    if (state.committing || !state.valid || !state.selected.size || !state.file) return;
    state.committing = true;
    state.request?.abort();
    const body = { ...input(), keys: [...state.selected] };
    const controls = [...form.querySelectorAll('input,select,button')].map((c) => [c, c.disabled]);
    for (const [c] of controls) c.disabled = true;
    dialog.querySelector('[data-excel-close]').disabled = true;
    status.textContent = 'Seçilen kayıtlar aktarılıyor…';
    try {
      const result = await request('commit', body);
      if (!form.isConnected) return;
      window.modalFormSaved?.(form);
      preview.innerHTML =
        '<div class="formbody"><h3>Aktarım tamamlandı</h3><p>' +
        result.imported +
        ' kayıt eklendi, ' +
        result.skipped +
        ' mevcut kayıt atlandı.</p>' +
        (result.payments
          ? '<p>' + result.payments + ' geçmiş tahsilat kasa/banka bakiyesine işlenmeden kaydedildi.</p>'
          : '') +
        '<ul>' +
        result.records
          .map((r) => '<li>' + esc(r.name) + (r.number ? ' · Föy ' + esc(r.number) : '') + '</li>')
          .join('') +
        '</ul></div>';
      status.textContent = 'Kayıtlar bu uygulamanın kullandığı veritabanına kaydedildi.';
      dialog.querySelector('[data-excel-close]').onclick = () => {
        dialog.close();
        if (kind === 'clients' && result.records[0]) recordClientList.q = result.records[0].name;
        if (kind === 'documents') {
          selected = '';
          recordIntakeList.query = '';
          recordIntakeList.index = 0;
        }
        render();
      };
      state.selected.clear();
      state.file = null;
    } catch (error) {
      if (form.isConnected) {
        status.textContent = error.message + ' Önizlemeyi yenileyerek tekrar deneyebilirsiniz.';
        for (const [c, disabled] of controls) c.disabled = disabled;
      }
    } finally {
      state.committing = false;
      if (form.isConnected) {
        dialog.querySelector('[data-excel-close]').disabled = false;
        selectionSummary();
      }
    }
  };
}

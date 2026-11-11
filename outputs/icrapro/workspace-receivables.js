function setupReceivables(form, original) {
  form.classList.add('folio-intake');
  if (original && !Array.isArray(original.receivables)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.dataset.appendReceivable = 'true';
    button.textContent = '＋ Bu Föye Farklı Evrak Ekle';
    button.disabled = ['İnfaz', 'İade'].includes(original.status);
    if (button.disabled) button.title = 'Kapanmış föye alacak evrakı eklenemez.';
    form.querySelector('.panelhead').append(button);
    button.onclick = () => {
      const item = {
        ...original,
        id: crypto.randomUUID(),
        amount: original.originalAmount ?? original.amount,
        preTrackingPayment: original.preTrackingPayment || 0,
        docType: original.docType || 'Senet',
      };
      setupReceivables(form, { ...original, receivables: [item] });
      form.querySelector('[data-form-tab="debtor"]')?.click();
      button.remove();
    };
    return;
  }
  const host = document.createElement('section');
  host.className = 'formbody receivable-workspace';
  host.dataset.receivables = 'true';
  host.innerHTML =
    '<div class="receivable-heading"><div><h3>Alacak Evrakları</h3><p>Farklı cins evrakları aynı föye ekleyin. Ayrıntıları düzenlemek için bir satır seçin.</p></div><span class="badge">Tek Föy</span></div>' +
    '<div data-receivable-picker></div><div class="receivable-layout"><div class="receivable-ledger"><div class="receivable-table-scroll"><table class="receivable-table"><caption class="sr-only">Bu föyün alacak evrakları; tarih sütunu vade veya ibraz tarihini gösterir.</caption><thead><tr><th scope="col">Tarih</th><th scope="col">Tutar</th><th scope="col">PB</th><th scope="col">Tür</th><th scope="col"><span class="sr-only">Ayrıntı</span></th></tr></thead><tbody data-receivable-table></tbody><tfoot><tr><th scope="row">TOPLAM</th><td data-receivable-gross>0,00</td><td>TL</td><td colspan="2" data-receivable-count>0 evrak</td></tr></tfoot></table></div><p class="receivable-ledger-note">Tarih: vade / ibraz tarihi</p></div><div class="receivable-detail"><div class="receivable-detail-heading"><h4>Evrak Ayrıntısı</h4><span data-receivable-position></span></div><p class="receivable-empty" data-receivable-empty>Föye evrak eklemek için yukarıdan evrak cinsini seçin.</p><div data-receivable-rows></div></div></div><div class="receivable-footer" role="status" data-receivable-total></div>';
  form.querySelector('.formbody').after(host);
  const picker = form.querySelector('.document-types');
  host.querySelector('[data-receivable-picker]').append(picker);
  const select = form.elements.docType;
  if (![...select.options].some((option) => option.value === 'Alacak Föyü'))
    select.add(new Option('Alacak Föyü'));
  select.value = 'Alacak Föyü';
  select.disabled = false;
  select.onchange();
  const heading = form.querySelector('#intakeHeading');
  if (heading) heading.textContent = original ? 'Föy · Evrak Kayıt' : 'Yeni Föy · Evrak Kayıt';
  const intro = form.querySelector('.panelhead > div > p');
  if (intro)
    intro.textContent = 'Müvekkil ve borçlu bilgilerini girin; alacakları aşağıdaki listeye ekleyin.';
  const documentGrid = form.querySelector('[data-form-panel="document"] .grid');
  const clientField = form.elements.client?.closest('label');
  const debtorField = form.elements.debtor?.closest('label');
  if (documentGrid && clientField && debtorField) {
    clientField.classList.add('folio-client-field');
    debtorField.classList.add('folio-debtor-field');
    clientField.after(debtorField);
    form.elements.clientParty?.closest('label')?.classList.add('folio-party-field');
  }
  if (!original && form.querySelector('.badge')) form.querySelector('.badge').textContent = 'Boş Föy';
  form.querySelector('#typeFields').hidden = true;
  form
    .querySelector('[data-form-tab="debtor"]')
    ?.setAttribute('aria-label', 'Borçlu bilgileri ve aynı föyün evrakları');
  for (const name of ['amount', 'due', 'serial', 'issued', 'preTrackingPayment']) {
    const control = form.elements[name];
    control.closest('label').hidden = true;
    control.type = 'hidden';
    control.disabled = false;
    control.required = false;
    control.dataset.optional = 'true';
  }
  const list = host.querySelector('[data-receivable-rows]');
  const total = host.querySelector('[data-receivable-total]');
  const table = host.querySelector('[data-receivable-table]');
  const insert = document.createElement('button');
  insert.type = 'button';
  insert.className = 'secondary';
  insert.dataset.openClaimMenu = 'true';
  insert.textContent = '＋ Evrak Ekle';
  insert.setAttribute('aria-haspopup', 'menu');
  host.querySelector('.receivable-heading').append(insert);
  picker.hidden = true;
  const ledger = host.querySelector('.receivable-table-scroll');
  ledger.tabIndex = 0;
  ledger.setAttribute(
    'aria-label',
    'Alacak evrakları. Evrak eklemek için boş alanda sağ tıklayın veya Evrak Ekle düğmesini kullanın.',
  );
  let menuCleanup;
  function openMenu(x, y) {
    menuCleanup?.();
    const menu = document.createElement('div');
    menu.className = 'receivable-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Evrak Ekle');
    menu.innerHTML = '<div class="receivable-menu-title">Evrak Ekle</div>';
    for (const type of HanReceivables.types) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = type;
      button.onclick = () => {
        menuCleanup();
        [...picker.querySelectorAll('button')].find((item) => item.dataset.docType === type)?.click();
      };
      menu.append(button);
    }
    document.body.append(menu);
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    const controller = new AbortController();
    menuCleanup = () => {
      controller.abort();
      menu.remove();
      menuCleanup = null;
      insert.setAttribute('aria-expanded', 'false');
    };
    insert.setAttribute('aria-expanded', 'true');
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!menu.contains(event.target)) menuCleanup?.();
      },
      { signal: controller.signal },
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          menuCleanup?.();
          insert.focus();
        }
      },
      { signal: controller.signal },
    );
    window.addEventListener('resize', () => menuCleanup?.(), { signal: controller.signal });
    menu.onkeydown = (event) => {
      const buttons = [...menu.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    menu.querySelector('button').focus();
  }
  insert.onclick = () => {
    const rect = insert.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 4);
  };
  ledger.oncontextmenu = (event) => {
    if (event.target.closest('[data-select-claim],thead,tfoot')) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY);
  };
  ledger.onkeydown = (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = ledger.getBoundingClientRect();
      openMenu(rect.left + 16, rect.top + 35);
    }
  };
  form.addEventListener('reset', () => menuCleanup?.());
  let selectedRow = null;
  const amountText = (value) =>
    Number.isFinite(value)
      ? value.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';
  function selectRow(row) {
    selectedRow = row;
    for (const editor of list.children) editor.hidden = editor !== row;
    for (const entry of table.querySelectorAll('[data-select-claim]')) {
      const selected = entry.dataset.selectClaim === row?.dataset.id;
      entry.classList.toggle('selected', selected);
      entry.querySelector('button')?.setAttribute('aria-current', String(selected));
    }
    const index = [...list.children].indexOf(row);
    host.querySelector('[data-receivable-position]').textContent = row
      ? index + 1 + ' / ' + list.children.length
      : '';
    host.querySelector('[data-receivable-empty]').hidden = list.children.length > 0;
  }
  function readRow(row) {
    const result = { id: row.dataset.id, docType: row.querySelector('[data-claim-type]').value };
    for (const control of row.querySelectorAll('[data-claim-field]'))
      result[control.dataset.claimField] = control.value;
    if (result.docType === 'Yediemin Park Ücreti' && !['İnfaz', 'İade'].includes(original?.status)) {
      const info = parkingFeeInfo(result, businessDate());
      if (info) {
        result.amount = String(info.amount / 100);
        row.querySelector('[data-claim-field="amount"]').value = result.amount;
      }
    }
    return result;
  }
  function controls(row, item) {
    const type = row.querySelector('[data-claim-type]').value;
    const definition = documentTypes[type];
    const fields = row.querySelector('[data-claim-fields]');
    fields.replaceChildren();
    const definitions = [
      [definition.amount, 'amount', 'number'],
      ['Takip Öncesi Ödeme (₺)', 'preTrackingPayment', 'number'],
      [definition.serial, 'serial', 'text'],
      [definition.due, 'due', 'date'],
      ['Düzenleme Tarihi', 'issued', 'date'],
      ...definition.extras,
    ];
    for (const extra of definitions) {
      const [label, name, inputType] = extra;
      if (type === 'Yediemin Park Ücreti' && name === 'due') continue;
      const wrapper = document.createElement('div');
      wrapper.innerHTML =
        inputType === 'select'
          ? documentExtraField(extra, item[name] || '')
          : field(label, name, inputType || 'text', item[name] ?? (name === 'preTrackingPayment' ? 0 : ''));
      const labelElement = wrapper.firstElementChild;
      const control = labelElement.querySelector('input,select');
      control.dataset.claimField = name;
      control.removeAttribute('name');
      control.required =
        name === 'amount' ||
        (name === 'due' && definition.requiredDue) ||
        (name === 'serial' && type === 'Çek') ||
        (type === 'Yediemin Park Ücreti' &&
          ['parkingEntry', 'vehicleKind', 'parkingCommissionRate'].includes(name));
      control.dataset.optional = control.required ? 'false' : 'true';
      if (inputType === 'number') {
        control.min = name === 'amount' ? '0.01' : '0';
        control.step = '0.01';
        if (name === 'parkingCommissionRate') control.max = '100';
      }
      fields.append(labelElement);
    }
    fields.oninput = updateTotal;
    fields.onchange = updateTotal;
  }
  function updateTotal() {
    let gross = 0,
      paid = 0;
    table.replaceChildren();
    for (const row of list.children) {
      const value = readRow(row);
      const amount = Math.round(Number(value.amount || 0) * 100);
      const payment = Math.round(Number(value.preTrackingPayment || 0) * 100);
      gross += amount;
      paid += payment;
      const entry = document.createElement('tr');
      entry.dataset.selectClaim = row.dataset.id;
      const date = value.due || value.parkingEntry || value.issued;
      entry.innerHTML =
        '<td><button type="button" class="receivable-date" aria-label="' +
        esc(value.docType + ' evrakını düzenle') +
        '">' +
        esc(date ? displayDate(date) : 'Tarih girin') +
        '</button></td><td>' +
        amountText(amount / 100) +
        '</td><td>TL</td><td>' +
        esc(value.docType) +
        '</td><td><button type="button" class="receivable-info" aria-label="' +
        esc(value.docType + ' ayrıntısı') +
        '">i</button></td>';
      entry.onclick = () => selectRow(row);
      for (const button of entry.querySelectorAll('button')) button.setAttribute('aria-controls', row.id);
      entry.onkeydown = (event) => {
        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const rows = [...list.children],
          index = rows.indexOf(row);
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + step))];
        selectRow(next);
        [...table.children]
          .find((item) => item.dataset.selectClaim === next.dataset.id)
          ?.querySelector('button')
          ?.focus();
      };
      table.append(entry);
      row.querySelector('[data-claim-principal]').textContent = amountText((amount - payment) / 100) + ' TL';
    }
    if (!list.children.length)
      table.innerHTML = '<tr><td colspan="5" class="receivable-table-empty">Henüz evrak eklenmedi.</td></tr>';
    host.querySelector('[data-receivable-gross]').textContent = amountText(gross / 100);
    host.querySelector('[data-receivable-count]').textContent = list.children.length + ' evrak';
    total.innerHTML =
      '<span>' +
      list.children.length +
      ' evrak · Tek föy</span><span>Takip Öncesi Ödeme <strong>' +
      amountText(paid / 100) +
      ' TL</strong></span><span>Asıl Alacak <strong>' +
      amountText((gross - paid) / 100) +
      ' TL</strong></span>';
    selectRow(selectedRow?.isConnected ? selectedRow : list.firstElementChild);
    form.dispatchEvent(new CustomEvent('receivables-change'));
  }
  function add(item) {
    if (list.children.length >= 100) return toast('Bir föye en fazla 100 evrak ekleyebilirsiniz.');
    const row = document.createElement('section');
    row.className = 'receivable-editor';
    row.dataset.id = item.id || crypto.randomUUID();
    row.id = 'claim-editor-' + row.dataset.id;
    row.innerHTML =
      '<div class="receivable-editor-heading"><label class="field">Evrak Türü<select data-claim-type>' +
      HanReceivables.types.map((type) => '<option>' + esc(type) + '</option>').join('') +
      '</select></label><button type="button" class="link" data-remove-claim>Evrakı Kaldır</button></div><div class="grid" data-claim-fields></div><div class="receivable-principal"><span>Talep Edilen Asıl Alacak</span><strong data-claim-principal>0,00 TL</strong></div>';
    const type = row.querySelector('[data-claim-type]');
    type.value = item.docType || 'Senet';
    type.onchange = () => {
      controls(row, readRow(row));
      updateTotal();
    };
    row.querySelector('[data-remove-claim]').onclick = () => {
      const next = row.nextElementSibling || row.previousElementSibling;
      if (selectedRow === row) selectedRow = next;
      row.remove();
      updateTotal();
    };
    controls(row, item);
    list.append(row);
    selectedRow = row;
    updateTotal();
  }
  picker.querySelectorAll('button').forEach((button) => {
    button.classList.remove('selected');
    button.setAttribute('aria-pressed', 'false');
    button.disabled = false;
    button.onclick = () => {
      add({ docType: button.dataset.docType });
      form.querySelector('[data-intake-sheet-tab="claims"]')?.click();
      selectedRow?.querySelector('[data-claim-field="amount"]')?.focus();
    };
  });
  for (const item of original?.receivables || []) add(item);
  form.readReceivables = () => HanReceivables.normalize([...list.children].map(readRow));
  form._prepareRequiredValidation = () => {
    if (!list.children.length) {
      toast('Borçluya en az bir alacak evrakı ekleyin.');
      return false;
    }
    const invalidRow = [...list.children].find((row) =>
      [...row.querySelectorAll('input,select')].some((input) => !input.validity.valid),
    );
    if (invalidRow) selectRow(invalidRow);
    return true;
  };
  host.addEventListener(
    'invalid',
    (event) => {
      const row = [...list.children].find((editor) =>
        [...editor.querySelectorAll('input,select')].some((input) => !input.validity.valid),
      );
      if (row) {
        selectRow(row);
        if (!row.contains(event.target)) event.preventDefault();
      }
    },
    true,
  );
  const additional = form.querySelector('#intakeAddAnother');
  if (additional) {
    additional.checked = false;
    additional.closest('.formbody').hidden = true;
  }
  form.addEventListener('reset', () =>
    queueMicrotask(() => {
      list.replaceChildren();
      for (const item of original?.receivables || []) add(item);
      select.value = 'Alacak Föyü';
      updateTotal();
    }),
  );
  updateTotal();
}

function setupIntakeBorrowerSheet(form, original) {
  form.classList.add('compact-borrower-sheet', 'intake-borrower-sheet');
  const head = form.querySelector(':scope > .panelhead');
  const body = form.querySelector(':scope > .formbody');
  const heading = head.querySelector('h2');
  heading.innerHTML =
    'Borçlu Föyü · <span class="sheet-folio-number">' + esc(original?.number || 'Yeni Kayıt') + '</span>';
  head.querySelector('.badge')?.remove();
  const actions = document.createElement('div');
  actions.className = 'toolbar intake-sheet-actions';
  for (const title of ['Ara', 'Tahsilat', 'Ödeme Sözü', 'Masraf', 'Borcu Yapılandır']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = ['Ara', 'Tahsilat', 'Borcu Yapılandır'].includes(title) ? 'primary' : 'secondary';
    button.textContent = title;
    button.disabled = true;
    button.title = 'Bu işlemler föy kaydedildikten sonra borçlu föyünden yapılabilir.';
    actions.append(button);
  }
  const status = document.createElement('span');
  status.className = 'intake-sheet-status';
  status.textContent = 'Dosya Durumu: Derdest';
  actions.append(status);
  const save = form.querySelector('#accept');
  actions.append(save);
  head.append(actions);
  const meta = document.createElement('div');
  meta.className = 'sheet-metadata';
  const value = (label, key, extra = '') => {
    const cell = document.createElement('div');
    cell.className = 'sheet-meta-field ' + extra;
    cell.innerHTML = '<small>' + esc(label) + '</small>';
    if (['debtor', 'identity', 'phone1', 'address'].includes(key)) {
      const input = document.createElement('input');
      input.type = key === 'phone1' ? 'tel' : 'text';
      input.dataset.draftMeta = key;
      input.dataset.optional = 'true';
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        form.elements[key].value = input.value;
        form.elements[key].dispatchEvent(new Event('input', { bubbles: true }));
      });
      cell.append(input);
    } else {
      const text = document.createElement('strong');
      text.dataset.draftMeta = key;
      cell.append(text);
    }
    meta.append(cell);
    return cell;
  };
  function move(name, label, extra = '') {
    const input = form.elements[name] || form.querySelector('#' + name);
    const wrapper = input?.closest('.field');
    if (!wrapper) return value(label, name, extra);
    const cell = document.createElement('div');
    cell.className = 'sheet-meta-field ' + extra;
    cell.innerHTML = '<small>' + esc(label) + '</small>';
    for (const control of wrapper.querySelectorAll('input,select,textarea'))
      if (!control.getAttribute('aria-label')) control.setAttribute('aria-label', label);
    if (wrapper.firstChild?.nodeType === 3) wrapper.firstChild.textContent = '';
    cell.append(wrapper);
    meta.append(cell);
    return cell;
  }
  const folioCell = move('intakeFolioNumber', 'Föy No', 'sheet-folio-number');
  const imatikCell = move('imatikFolioNumber', 'İ.Matik Föy No (isteğe bağlı)');
  folioCell.append(...imatikCell.childNodes);
  imatikCell.remove();
  value('Borçlu', 'debtor', 'sheet-debtor-name');
  move('intakeTrackingDate', 'Takip Tarihi');
  move('recordedBy', 'Evrakı Kaydeden');
  value('Evrak Türü', 'types');
  value('Durum', 'status');
  move('relatedStaff', 'Dosya Sorumlusu');
  move('client', 'Müvekkil');
  value('Vade Tarihi', 'due');
  value('TC / Vergi No', 'identity');
  value('Telefon', 'phone1');
  value('İl / İlçe', 'location');
  const enforcement = document.createElement('div');
  enforcement.className = 'sheet-enforcement-form';
  for (const name of ['enforcementOffice', 'enforcementFileNumber']) {
    const wrapper = form.elements[name]?.closest('.field');
    if (wrapper) enforcement.append(wrapper);
  }
  meta.append(enforcement);
  value('Adres', 'address', 'intake-sheet-address');
  head.after(meta);
  const workspace = document.createElement('div');
  workspace.className = 'sheet-workspace';
  body.before(workspace);
  workspace.append(body);
  const oldNav = body.querySelector('.record-form-tabs');
  const oldButtons = new Map(
    [...oldNav.querySelectorAll('[data-form-tab]')].map((button) => [button.dataset.formTab, button]),
  );
  const panels = new Map(
    [...body.querySelectorAll('[data-form-panel]')].map((panel) => [panel.dataset.formPanel, panel]),
  );
  const personal = panels.get('debtor'),
    documents = panels.get('document');
  const debtorField = form.elements.debtor.closest('.field');
  personal.querySelector('.grid').prepend(debtorField);
  for (const key of ['address']) {
    const panel = panels.get(key);
    personal.querySelector('.grid').append(...panel.querySelector('.grid').children);
    panel.hidden = true;
  }
  for (const key of ['delivery', 'files']) {
    const panel = panels.get(key);
    documents.querySelector('.grid').append(...panel.querySelector('.grid').children);
    panel.hidden = true;
  }
  body.querySelector('.intake-record-header')?.remove();
  body.querySelector(':scope > .notice')?.remove();
  const claims = document.createElement('section');
  claims.className = 'intake-claims-panel';
  claims.dataset.formPanel = 'claims';
  claims.append(form.querySelector('[data-receivables]'));
  body.append(claims);
  panels.set('claims', claims);
  const placeholders = {
    conversations: ['Görüşmeler', 'Görüşme kayıtları föy kaydedildikten sonra burada yer alır.'],
    financial: ['Finansal İşlemler', 'Bu yeni föyde henüz tahsilat veya masraf hareketi yok.'],
    payout: ['Müvekkile Ödeme', 'Bu yeni föyde henüz müvekkil ödemesi yok.'],
  };
  for (const [key, [label, note]] of Object.entries(placeholders)) {
    const panel = document.createElement('section');
    panel.dataset.formPanel = key;
    panel.innerHTML =
      '<h3 class="sectiontitle">' + label + '</h3><p class="intake-sheet-empty">' + note + '</p>';
    body.append(panel);
    panels.set(key, panel);
  }
  const tabs = [
    ['debtor', 'Kimlik ve İletişim'],
    ['claims', 'Alacak'],
    ['assets', 'Tapu / Araç / SGK'],
    ['guarantors', 'Kefiller'],
    ['conversations', 'Görüşmeler'],
    ['financial', 'Finansal İşlemler'],
    ['document', 'Evrak Bilgileri'],
    ['payout', 'Müvekkile Ödeme'],
  ];
  oldNav.className = 'settings-tabs borrower-tabs intake-sheet-tabs';
  oldNav.replaceChildren();
  function select(key) {
    for (const [name, panel] of panels) panel.hidden = name !== key;
    for (const button of oldNav.querySelectorAll('button')) {
      const active = button.dataset.intakeSheetTab === key;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-selected', String(active));
    }
    form.dataset.activeFormTab = key;
  }
  for (const [key, label] of tabs) {
    const button = oldButtons.get(key) || document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.intakeSheetTab = key;
    button.id = 'intake-sheet-tab-' + key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'intake-sheet-panel-' + key);
    const panel = panels.get(key);
    panel.id = 'intake-sheet-panel-' + key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    button.onclick = () => select(key);
    oldNav.append(button);
  }
  form.addEventListener('record-form-tab', (event) =>
    select(
      event.detail.key === 'address'
        ? 'debtor'
        : ['delivery', 'files'].includes(event.detail.key)
          ? 'document'
          : event.detail.key,
    ),
  );
  form.addEventListener(
    'invalid',
    (event) => {
      const panel = event.target.closest('[data-form-panel]');
      if (panel) select(panel.dataset.formPanel);
    },
    true,
  );
  const summary = document.createElement('section');
  summary.className = 'sheet-finance-summary';
  summary.setAttribute('aria-label', 'Dosya Hesabı');
  const labels = [
    'Evrak Tutarı',
    'Takip Öncesi Ödeme',
    'Asıl Alacak',
    'İşlemiş Faiz',
    'Avukatlık Ücreti',
    'Dosya Masrafı',
    'İndirim',
    'Toplam Alacak',
    'Toplam Ödenen',
    'Kalan Alacak',
  ];
  summary.innerHTML =
    '<h3>Dosya Hesabı</h3><div class="sheet-summary-date">Hesap Tarihi <b>' +
    esc(displayDate(businessDate())) +
    '</b></div>' +
    labels
      .map(
        (label, index) =>
          '<div class="sheet-finance-line ' +
          (index === 9 ? 'sheet-balance' : index === 7 ? 'sheet-total' : '') +
          '"><span>' +
          label +
          '</span><strong data-draft-balance="' +
          index +
          '">0,00 TL</strong></div>',
      )
      .join('');
  workspace.append(summary);
  function refresh() {
    const inputs = form.elements;
    const items = [...form.querySelectorAll('[data-receivable-rows] > section')].map((row) => ({
      docType: row.querySelector('[data-claim-type]').value,
      amount: Number(row.querySelector('[data-claim-field="amount"]')?.value || 0),
      paid: Number(row.querySelector('[data-claim-field="preTrackingPayment"]')?.value || 0),
      due: row.querySelector('[data-claim-field="due"]')?.value || '',
    }));
    const today = businessDate(),
      dates = items
        .map((item) => item.due)
        .filter(Boolean)
        .sort();
    const values = {
      debtor: inputs.debtor.value,
      types: [...new Set(items.map((item) => item.docType))].join(', '),
      status: inputs.enforcementFileNumber?.value.trim() ? 'İcra' : 'Derdest',
      due: displayDate(dates[0] || ''),
      identity: inputs.identity.value,
      phone1: inputs.phone1.value,
      location: [inputs.city.value, inputs.district.value].filter(Boolean).join(' / '),
      address: inputs.address.value,
    };
    meta.querySelectorAll('[data-draft-meta]').forEach((node) => {
      const text = values[node.dataset.draftMeta] || '';
      if (node.tagName === 'INPUT') node.value = text;
      else node.textContent = text;
    });
    status.textContent = 'Dosya Durumu: ' + values.status;
    const gross = items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0),
      paid = items.reduce((sum, item) => sum + Math.round(item.paid * 100), 0),
      principal = gross - paid;
    let interest = 0,
      fee = 0;
    const standard = items.filter((item) => item.docType !== 'Yediemin Park Ücreti');
    try {
      if (typeof calculateLegalInterest === 'function')
        for (const item of standard)
          if (item.amount > item.paid && item.due && item.due < today)
            interest += calculateLegalInterest(
              Math.round((item.amount - item.paid) * 100),
              item.due,
              today,
            ).amount;
      const standardPrincipal = standard.reduce(
        (sum, item) => sum + Math.round((item.amount - item.paid) * 100),
        0,
      );
      if (standardPrincipal > 0 && typeof calculateEnforcementFee === 'function')
        fee = calculateEnforcementFee(standardPrincipal + interest, standardPrincipal, false).amount;
    } catch {
      interest = 0;
      fee = 0;
    }
    const events =
      typeof financeEvents === 'undefined'
        ? []
        : financeEvents.filter((event) => event.documentId === original?.id);
    if (
      original &&
      (original.financeTermsManual ||
        original.repaymentPlan ||
        events.some((event) => event.type === 'payment'))
    ) {
      interest = Math.round(Number(original.financeInterest || 0) * 100);
      fee = Math.round(Number(original.financeFee || 0) * 100);
    }
    const expenses = events
        .filter((event) => event.type === 'expense')
        .reduce((sum, event) => sum + event.amount, 0),
      discount = Number(original?.debtDiscountCents || 0),
      received = events
        .filter((event) => event.type === 'payment')
        .reduce((sum, event) => sum + event.amount, 0);
    const target = Math.max(0, principal + interest + fee + expenses - discount);
    const balances = [
      gross,
      paid,
      principal,
      interest,
      fee,
      expenses,
      discount,
      target,
      received,
      Math.max(0, target - received),
    ];
    summary
      .querySelectorAll('[data-draft-balance]')
      .forEach((node) => (node.textContent = money(balances[Number(node.dataset.draftBalance)] / 100)));
  }
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('receivables-change', refresh);
  form.addEventListener('reset', () =>
    queueMicrotask(() => {
      select('debtor');
      refresh();
    }),
  );
  select('debtor');
  refresh();
}

function receivableSummary(doc) {
  if (!Array.isArray(doc.receivables)) return '';
  return (
    '<section><h3 class="sectiontitle">Alacak Evrakları · Tek Föy</h3><div class="overflow"><table><thead><tr><th>TÜR</th><th>EVRAK NO</th><th>VADE</th><th>TUTAR</th><th>TAKİP ÖNCESİ ÖDEME</th><th>ANAPARA</th></tr></thead><tbody>' +
    doc.receivables
      .map(
        (item) =>
          '<tr><td>' +
          esc(item.docType) +
          '</td><td>' +
          esc(item.serial || '—') +
          '</td><td>' +
          esc(displayDate(item.due) || '—') +
          '</td><td>' +
          money(item.amount) +
          '</td><td>' +
          money(item.preTrackingPayment || 0) +
          '</td><td>' +
          money(Number(item.amount) - Number(item.preTrackingPayment || 0)) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div></section>'
  );
}

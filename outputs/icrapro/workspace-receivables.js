function setupReceivables(form, original) {
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
  host.className = 'full';
  host.dataset.receivables = 'true';
  host.innerHTML =
    '<h3 class="sectiontitle">Borçluya Ait Alacak Evrakları</h3><p>Aynı borçlu için farklı türlerde evrak ekleyin. Borç ve tahsilat tek föyde toplanır.</p><div data-receivable-picker></div><div data-receivable-rows></div><p role="status" data-receivable-total></p>';
  const debtor = form.querySelector('[data-form-panel="debtor"] .grid');
  debtor.append(host);
  const picker = form.querySelector('.document-types');
  host.querySelector('[data-receivable-picker]').append(picker);
  const select = form.elements.docType;
  if (![...select.options].some((option) => option.value === 'Alacak Föyü'))
    select.add(new Option('Alacak Föyü'));
  select.value = 'Alacak Föyü';
  select.disabled = false;
  select.onchange();
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
        control.min = '0';
        control.step = '0.01';
        if (name === 'parkingCommissionRate') control.max = '100';
      }
      fields.append(labelElement);
    }
    fields.oninput = updateTotal;
    fields.onchange = updateTotal;
  }
  function updateTotal() {
    let sum = 0;
    for (const row of list.children) {
      const value = readRow(row);
      sum +=
        Math.round(Number(value.amount || 0) * 100) - Math.round(Number(value.preTrackingPayment || 0) * 100);
    }
    total.textContent = list.children.length + ' evrak · Toplam anapara: ' + money(sum / 100);
  }
  function add(item) {
    if (list.children.length >= 100) return toast('Bir föye en fazla 100 evrak ekleyebilirsiniz.');
    const row = document.createElement('section');
    row.className = 'panel';
    row.style.marginBottom = '16px';
    row.dataset.id = item.id || crypto.randomUUID();
    row.innerHTML =
      '<div class="panelhead"><label class="field">Evrak Türü<select data-claim-type>' +
      HanReceivables.types.map((type) => '<option>' + esc(type) + '</option>').join('') +
      '</select></label><button type="button" class="link" data-remove-claim>Evrakı Kaldır</button></div><div class="formbody grid" data-claim-fields></div>';
    const type = row.querySelector('[data-claim-type]');
    type.value = item.docType || 'Senet';
    type.onchange = () => {
      controls(row, readRow(row));
      updateTotal();
    };
    row.querySelector('[data-remove-claim]').onclick = () => {
      row.remove();
      updateTotal();
    };
    controls(row, item);
    list.append(row);
    updateTotal();
    row.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
  picker.querySelectorAll('button').forEach((button) => {
    button.classList.remove('selected');
    button.setAttribute('aria-pressed', 'false');
    button.disabled = false;
    button.onclick = () => add({ docType: button.dataset.docType });
  });
  for (const item of original?.receivables || []) add(item);
  form.readReceivables = () => HanReceivables.normalize([...list.children].map(readRow));
  form._prepareRequiredValidation = () => {
    if (!list.children.length) {
      toast('Borçluya en az bir alacak evrakı ekleyin.');
      return false;
    }
    return true;
  };
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

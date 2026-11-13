function unitBalanceMarkup(doc, events = financeEvents) {
  if (!HanUnits.hasForeign(doc)) return '';
  return (
    '<section class="unit-finance-overview"><h3>Birim Bazında Alacaklar</h3>' +
    HanUnits.foreignBalances(doc, businessDate(), events)
      .map(
        (group) =>
          '<article class="unit-finance-card"><h4>' +
          esc(HanUnits.definitions[group.currency].label) +
          '</h4><dl>' +
          [
            ['Asıl Alacak', group.principal],
            ['Faiz', group.interest],
            ['Ücret', group.fee],
            ['İndirim', group.discount],
            ['Toplam Alacak', group.target],
            ['Ödenen', group.received],
            ['Kalan', group.remaining],
          ]
            .map(
              ([label, value]) =>
                '<div><dt>' +
                label +
                '</dt><dd>' +
                esc(HanUnits.formatMinor(value, group.currency)) +
                '</dd></div>',
            )
            .join('') +
          '</dl><button type="button" class="primary" data-unit-collection="' +
          group.currency +
          '">TL Tahsilat Al</button></article>',
      )
      .join('') +
    '</section>'
  );
}
function installUnitFinanceSummary(dialog, doc) {
  if (!HanUnits.hasForeign(doc)) return;
  const target =
    dialog.querySelector('.sheet-finance-summary') ||
    dialog.querySelector('[data-borrower-panel="financial"]');
  if (!target) return;
  target.querySelector('.unit-finance-overview')?.remove();
  const heading = target.querySelector('h3');
  if (heading) heading.textContent = 'Dosya Hesabı · TL';
  const section = document.createElement('div');
  section.innerHTML = unitBalanceMarkup(doc);
  target.append(section);
  section
    .querySelectorAll('[data-unit-collection]')
    .forEach((button) => (button.onclick = () => openUnitFinance(doc.id, button.dataset.unitCollection)));
}
async function readUnitFinance(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Birim hesabı yüklenemedi.');
  return result;
}
async function openUnitFinance(id, selectedCurrency) {
  const doc = db.docs.find((d) => d.id === id);
  if (!doc) return;
  let dialog = document.getElementById('unitFinanceDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'unitFinanceDialog';
    dialog.className = 'unit-finance-dialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>' +
    esc(doc.number) +
    ' · Birim Bazında Tahsilat</h2><button type="button" class="link" data-unit-close>Kapat</button></div><div class="formbody" role="status">Hesap yükleniyor…</div>';
  dialog.querySelector('[data-unit-close]').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  let initial;
  try {
    initial = await readUnitFinance(
      '/api/documents/currency-finance?' + new URLSearchParams({ documentId: id }),
    );
  } catch (error) {
    dialog.querySelector('[role=status]').textContent = error.message;
    return;
  }
  if (!dialog.open) return;
  const currencies = initial.groups.map((g) => g.currency);
  if (!currencies.includes(selectedCurrency)) selectedCurrency = currencies[0];
  if (!selectedCurrency) {
    dialog.close();
    return financialOperations(id, 'payment', true);
  }
  const staffMarkup = turnoverStaffField();
  dialog.innerHTML =
    '<div class="panelhead"><div><h2>' +
    esc(doc.number) +
    ' · TL ile Döviz / Altın Tahsilatı</h2><p>' +
    esc(doc.debtor) +
    '</p></div><div class="toolbar"><button type="button" class="secondary" data-open-tl-finance>TL Hesabı</button><button type="button" class="link" data-unit-close>Kapat</button></div></div><form id="unitCollectionForm"><div class="formbody"><div class="grid"><label class="field">Borcun Birimi<select name="currency" required>' +
    currencies
      .map(
        (currency) =>
          '<option value="' +
          currency +
          '" ' +
          (currency === selectedCurrency ? 'selected' : '') +
          '>' +
          esc(HanUnits.definitions[currency].label) +
          '</option>',
      )
      .join('') +
    '</select></label><label class="field">Tahsilat Tarihi<input type="date" name="date" value="' +
    businessDate() +
    '" max="' +
    businessDate() +
    '" required></label></div><div class="unit-collection-balance" data-unit-balance></div><div class="notice" data-unit-rate role="status">Günlük kur yükleniyor…</div><div class="grid"><label class="field">Alınan Tutar (TL)<input type="text" inputmode="decimal" name="amount" required placeholder="0,00"></label><label class="field">Paranın Girdiği Kasa / Banka<select name="accountId" required><option value="">Hesap seçin</option>' +
    initial.accounts
      .map((account) => '<option value="' + esc(account.id) + '">' + esc(account.name) + '</option>')
      .join('') +
    '</select></label>' +
    staffMarkup +
    '<label class="field full">Açıklama / Dekont No<input name="note" maxlength="3000" required></label></div><p class="unit-conversion-preview" data-unit-conversion aria-live="polite"></p><p role="alert" data-unit-error></p></div><div class="actions"><button type="button" class="secondary" data-unit-refresh>Kuru / Hesabı Yenile</button><button class="primary" type="submit" disabled>Tahsilatı Kaydet</button></div></form>' +
    unitTermsFormMarkup() +
    '<section class="formbody"><h3>Tahsilat Geçmişi</h3><div class="overflow"><table><thead><tr><th>TARİH</th><th>ALINAN TL</th><th>BORÇTAN DÜŞÜLEN</th><th>KUR TARİHİ / KUR</th><th>PERSONEL</th></tr></thead><tbody data-unit-history></tbody></table></div></section>';
  const form = dialog.querySelector('form'),
    saveButton = form.querySelector('[type=submit]'),
    errorBox = form.querySelector('[data-unit-error]'),
    rateBox = form.querySelector('[data-unit-rate]');
  dialog.querySelector('[data-unit-close]').onclick = () => dialog.close();
  dialog.querySelector('[data-open-tl-finance]').onclick = () => {
    dialog.close();
    financialOperations(id, 'payment', true);
  };
  const other = form.elements.turnoverOther;
  form.elements.turnoverStaffId.onchange = () => {
    const on = form.elements.turnoverStaffId.value === '__other__';
    other.closest('label').hidden = !on;
    other.disabled = !on;
    other.required = on;
  };
  if (!['ceo', 'admin'].includes(hanAuth.role)) {
    form.elements.turnoverStaffId.value = hanAuth.staffId || doc.relatedStaff || '';
    form.elements.turnoverStaffId.disabled = true;
  }
  let data = null,
    requestSequence = 0,
    pending = false;
  function amountTL() {
    return financeCents(form.elements.amount.value);
  }
  function preview() {
    errorBox.textContent = '';
    saveButton.disabled = true;
    const target = form.querySelector('[data-unit-conversion]');
    target.textContent = '';
    if (!data?.quote || pending) return;
    try {
      const amount = amountTL();
      if (!Number.isSafeInteger(amount) || amount <= 0) return;
      const quantity = HanUnits.convertTL(amount, data.quote.rateMicros, form.elements.currency.value),
        group = data.groups.find((g) => g.currency === form.elements.currency.value);
      target.textContent =
        money(amount / 100) +
        ' = ' +
        HanUnits.formatMinor(quantity, group.currency) +
        ' · Tahsilat sonrası kalan: ' +
        HanUnits.formatMinor(Math.max(0, group.remaining - quantity), group.currency);
      if (quantity > group.remaining) {
        errorBox.textContent = 'Çevrilen tutar kalan alacağı aşıyor.';
        return;
      }
      saveButton.disabled = hanAuth.readOnly === true || dialog.dataset.folioReadOnly === 'true';
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }
  async function refresh() {
    const sequence = ++requestSequence;
    data = null;
    saveButton.disabled = true;
    rateBox.textContent = 'Günlük kur yükleniyor…';
    errorBox.textContent = '';
    try {
      const result = await readUnitFinance(
        '/api/documents/currency-quote?' +
          new URLSearchParams({
            documentId: id,
            currency: form.elements.currency.value,
            date: form.elements.date.value,
          }),
      );
      if (sequence !== requestSequence || !dialog.open) return;
      data = result;
      const group = data.groups.find((g) => g.currency === form.elements.currency.value),
        quote = data.quote;
      form.querySelector('[data-unit-balance]').textContent =
        'Asıl alacak: ' +
        HanUnits.formatMinor(group.principal, group.currency) +
        ' · Faiz: ' +
        HanUnits.formatMinor(group.interest, group.currency) +
        ' · Kalan: ' +
        HanUnits.formatMinor(group.remaining, group.currency);
      rateBox.textContent =
        '1 ' +
        HanUnits.definitions[group.currency].label +
        ' = ' +
        Number(quote.rate).toLocaleString('tr-TR', { maximumFractionDigits: 6 }) +
        ' TL · Kur tarihi: ' +
        displayDate(quote.rateDate) +
        ' · ' +
        quote.source +
        (quote.rateDate !== quote.date
          ? ' · İşlem tarihinde yayımlanan kur bulunmadığı için son yayımlanan tarih gösteriliyor.'
          : '');
      renderNativeUnitTerms(dialog, group, data.status);
      const history = dialog.querySelector('[data-unit-history]');
      history.innerHTML =
        data.history
          .slice()
          .reverse()
          .map(
            (event) =>
              '<tr><td>' +
              esc(displayDate(event.date)) +
              '</td><td>' +
              esc(money(event.amount / 100)) +
              '</td><td>' +
              esc(HanUnits.formatMinor(event.unitAllocation.quantityMinor, event.unitAllocation.currency)) +
              '</td><td>' +
              esc(displayDate(event.unitAllocation.rateDate)) +
              ' / ' +
              esc(
                (event.unitAllocation.rateMicros / 1000000).toLocaleString('tr-TR', {
                  maximumFractionDigits: 6,
                }),
              ) +
              '</td><td>' +
              esc(event.turnoverStaffName || event.operatorName || '—') +
              '</td></tr>',
          )
          .join('') || '<tr><td colspan="5">Henüz döviz veya altın tahsilatı yok.</td></tr>';
      preview();
    } catch (error) {
      if (sequence !== requestSequence) return;
      rateBox.textContent = 'Kur alınamadı.';
      errorBox.textContent = error.message;
    }
  }
  form.elements.amount.oninput = preview;
  form.elements.currency.onchange = refresh;
  form.elements.date.onchange = refresh;
  form.querySelector('[data-unit-refresh]').onclick = refresh;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (
      pending ||
      hanAuth.readOnly === true ||
      dialog.dataset.folioReadOnly === 'true' ||
      !data?.quote ||
      !form.reportValidity()
    )
      return;
    const amount = amountTL();
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    pending = true;
    saveButton.disabled = true;
    const nonce = (form.dataset.requestId ||= crypto.randomUUID());
    const turnoverStaffId =
      form.elements.turnoverStaffId.value === '__other__' ? other.value : form.elements.turnoverStaffId.value;
    const payload = {
      documentId: id,
      currency: form.elements.currency.value,
      date: form.elements.date.value,
      amount: amount / 100,
      accountId: form.elements.accountId.value,
      note: form.elements.note.value.trim(),
      turnoverStaffId,
      requestId: nonce,
      revision: data.revision,
      quoteId: data.quote.id,
    };
    try {
      const result = await readUnitFinance('/api/documents/currency-collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify(payload),
      });
      Object.assign(doc, result.record);
      if (!financeEvents.some((e) => e.id === result.payment.id)) financeEvents.push(result.payment);
      dialog.close();
      const redraw = () => {
        if (document.getElementById('borrowerDetail')?.open) borrowerDetail(id);
      };
      if (window.hanRecordsEnabled && typeof recordAction === 'function') await recordAction(id, redraw);
      else redraw();
      toast(
        money(result.payment.amount / 100) +
          ' tahsilat alındı · ' +
          HanUnits.formatMinor(
            result.payment.unitAllocation.quantityMinor,
            result.payment.unitAllocation.currency,
          ) +
          ' düşüldü · ' +
          (result.payment.collectionStaffName || result.payment.operatorName),
      );
    } catch (error) {
      errorBox.textContent = error.message;
      pending = false;
      preview();
      errorBox.textContent = error.message;
    }
  };
  const termsForm = dialog.querySelector('[data-unit-terms-form]');
  if (termsForm)
    termsForm.onsubmit = async (event) => {
      event.preventDefault();
      if (pending || !data?.quote || dialog.dataset.folioReadOnly === 'true' || !termsForm.reportValidity())
        return;
      pending = true;
      termsForm.querySelector('button').disabled = true;
      saveButton.disabled = true;
      errorBox.textContent = '';
      const payload = {
        documentId: id,
        currency: form.elements.currency.value,
        date: form.elements.date.value,
        revision: data.revision,
        requestId: (termsForm.dataset.requestId ||= crypto.randomUUID()),
        interest: termsForm.elements.unitInterest.value,
        fee: termsForm.elements.unitFee.value,
        discount: termsForm.elements.unitDiscount.value,
      };
      try {
        const result = await readUnitFinance('/api/documents/currency-terms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
          body: JSON.stringify(payload),
        });
        Object.assign(doc, result.record);
        delete termsForm.dataset.requestId;
        if (window.hanRecordsEnabled && typeof recordAction === 'function') await recordAction(id, () => {});
        pending = false;
        await refresh();
        toast(HanUnits.definitions[payload.currency].label + ' faiz ve ücret hesabı güncellendi.');
      } catch (error) {
        pending = false;
        termsForm.querySelector('button').disabled = false;
        preview();
        errorBox.textContent = error.message;
      }
    };
  await refresh();
  if (typeof bindFolioLock === 'function') bindFolioLock(dialog, id);
}
function unitPrincipalSupplement(doc) {
  const totals = doc.unitPrincipals || (doc.receivables ? HanUnits.principalTotals(doc.receivables) : {});
  return Object.entries(totals)
    .filter(([unit]) => unit !== 'TRY')
    .map(
      ([unit, value]) =>
        '<small class="unit-principal-supplement">' +
        esc(HanUnits.formatMinor(value.principal, unit)) +
        '</small>',
    )
    .join('');
}
function unitDocumentAmount(doc) {
  if (!HanUnits.hasForeign(doc)) return money(doc.amount);
  return Object.entries(HanUnits.principalTotals(doc.receivables))
    .map(([unit, value]) => HanUnits.formatMinor(value.principal, unit))
    .join(' · ');
}
function installCurrencyReportButton() {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  const toolbar =
    document.getElementById('reportShortcuts') || document.querySelector('#content .panelhead .toolbar');
  if (!toolbar || toolbar.querySelector('[data-open-unit-report]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.dataset.openUnitReport = 'true';
  button.textContent = 'Döviz / Altın Alacakları';
  button.onclick = openCurrencyReceivableReport;
  toolbar.prepend(button);
}
async function openCurrencyReceivableReport() {
  let dialog = document.getElementById('currencyReceivableReport');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'currencyReceivableReport';
    dialog.className = 'unit-finance-dialog';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<div class="panelhead"><h2>Döviz / Altın Alacakları</h2><button class="link" type="button" data-unit-report-close>Kapat</button></div><form class="formbody grid"><label class="field">Birim<select name="currency"><option value="">Tüm Birimler</option>' +
    Object.entries(HanUnits.definitions)
      .filter(([unit]) => unit !== 'TRY')
      .map(([unit, value]) => '<option value="' + unit + '">' + esc(value.label) + '</option>')
      .join('') +
    '</select></label><label class="field">Föy / Borçlu / Müvekkil<input type="search" name="q" maxlength="200" data-optional="true"></label><label class="field"><span>Kapalı Birim Bakiyeleri</span><input type="checkbox" name="includeClosed" data-optional="true"></label><button class="primary" type="submit">Filtrele</button></form><div class="formbody" data-unit-report-result role="status">Rapor yükleniyor…</div>';
  dialog.querySelector('[data-unit-report-close]').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  const form = dialog.querySelector('form'),
    target = dialog.querySelector('[data-unit-report-result]');
  let sequence = 0,
    offset = 0;
  async function load() {
    const current = ++sequence;
    try {
      const result = await readUnitFinance(
        '/api/documents/currency-report?' +
          new URLSearchParams({
            currency: form.elements.currency.value,
            q: form.elements.q.value.trim(),
            includeClosed: String(form.elements.includeClosed.checked),
            offset,
          }),
      );
      if (sequence !== current || !dialog.open) return;
      target.innerHTML =
        '<div class="stats">' +
        Object.entries(result.totals)
          .map(
            ([unit, value]) =>
              '<div class="stat"><div><small>' +
              esc(HanUnits.definitions[unit].label) +
              ' Kalan Alacak</small><strong>' +
              esc(HanUnits.formatMinor(value.remaining, unit)) +
              '</strong></div></div>',
          )
          .join('') +
        '</div><p>Hesap tarihi: ' +
        esc(displayDate(result.asOf)) +
        ' · ' +
        result.count +
        ' birim bakiyesi · Birimler birbirine eklenmez.</p><div class="overflow"><table><thead><tr><th>FÖY</th><th>BORÇLU</th><th>MÜVEKKİL</th><th>BİRİM</th><th>ASIL ALACAK</th><th>FAİZ</th><th>ÖDENEN</th><th>KALAN</th></tr></thead><tbody>' +
        result.rows
          .map(
            (row) =>
              '<tr><td><button type="button" class="link" data-unit-report-document="' +
              esc(row.documentId) +
              '">' +
              esc(row.number) +
              '</button></td><td>' +
              esc(row.debtor) +
              '</td><td>' +
              esc(row.client) +
              '</td><td>' +
              esc(HanUnits.definitions[row.currency].label) +
              '</td>' +
              ['principal', 'interest', 'received', 'remaining']
                .map((key) => '<td>' + esc(HanUnits.formatMinor(row[key], row.currency)) + '</td>')
                .join('') +
              '</tr>',
          )
          .join('') +
        (result.rows.length ? '' : '<tr><td colspan="8">Kayıt bulunamadı.</td></tr>') +
        '</tbody></table></div><div class="actions"><button type="button" class="secondary" data-unit-report-prev ' +
        (offset ? '' : 'disabled') +
        '>Önceki</button><button type="button" class="secondary" data-unit-report-next ' +
        (offset + 50 < result.count ? '' : 'disabled') +
        '>Sonraki</button></div>';
      target.querySelector('[data-unit-report-prev]').onclick = () => {
        offset = Math.max(0, offset - 50);
        load();
      };
      target.querySelector('[data-unit-report-next]').onclick = () => {
        offset += 50;
        load();
      };
      target
        .querySelectorAll('[data-unit-report-document]')
        .forEach(
          (button) =>
            (button.onclick = () =>
              recordAction(button.dataset.unitReportDocument, () =>
                borrowerDetail(button.dataset.unitReportDocument),
              )),
        );
    } catch (error) {
      if (current === sequence) target.textContent = error.message;
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    offset = 0;
    load();
  };
  await load();
}

function unitTermsFormMarkup() {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return '';
  return (
    '<details class="formbody"><summary>Faiz / Ücret / İndirim Düzenle</summary><p>Girdiğiniz tutarlar seçili alacağın kendi birimindedir. Asıl alacak bu bölümden indirilmez.</p><form data-unit-terms-form><div class="grid">' +
    [
      ['unitInterest', 'Faiz Tutarı'],
      ['unitFee', 'Ücret Tutarı'],
      ['unitDiscount', 'İndirim Tutarı'],
    ]
      .map(
        ([name, label]) =>
          '<label class="field">' +
          label +
          '<input type="number" name="' +
          name +
          '" min="0" step="0.01" value="0" required></label>',
      )
      .join('') +
    '</div><div class="actions"><button class="secondary" type="submit">Hesabı Güncelle</button></div></form></details>'
  );
}
function renderNativeUnitTerms(dialog, group, status) {
  const form = dialog.querySelector('[data-unit-terms-form]');
  if (!form) return;
  const definition = HanUnits.definitions[group.currency];
  for (const [name, key] of [
    ['unitInterest', 'interest'],
    ['unitFee', 'fee'],
    ['unitDiscount', 'discount'],
  ]) {
    const input = form.elements[name];
    input.step = group.currency === 'XAU' ? '0.001' : '0.01';
    input.value = String(group[key] / definition.scale);
    input.setAttribute('aria-label', key + ' · ' + definition.label);
    input.disabled = status === 'İnfaz';
  }
  form.querySelector('button').disabled = status === 'İnfaz';
}

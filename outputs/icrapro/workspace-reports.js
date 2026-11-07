function reportLocalDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
}

function reportRows(type) {
  const rows = [],
    clientName = (id) => db.clients.find((c) => c.id === id)?.name || '—',
    staffName = (id) => personnel.find((p) => p.id === id)?.name || '—',
    accountName = (id) => accounting.accounts.find((a) => a.id === id)?.name || 'Belirtilmedi';
  function add(date, doc, cells, meta = {}) {
    rows.push({
      date: reportLocalDate(date),
      clientId: doc?.client || '',
      staffId: doc?.relatedStaff || '',
      status: doc ? debtorStatus(doc) : '',
      accountId: '',
      cells,
      ...meta,
    });
  }
  function basic(d) {
    return { number: d.number, client: clientName(d.client), debtor: d.debtor };
  }
  if (type === 'excel') {
    const documents = new Map(db.docs.map((doc) => [doc.id, doc]));
    const clients = new Map(db.clients.map((client) => [client.id, client]));
    const staff = new Map(personnel.map((person) => [person.id, person]));
    for (const payment of financeEvents) {
      if (payment.type !== 'payment') continue;
      const doc = documents.get(payment.documentId);
      const client = clients.get(doc?.client);
      const staffId = payment.turnoverStaffId || payment.collectionStaffId || doc?.relatedStaff || '';
      const person = staff.get(staffId);
      const trackingDate = doc && borrowerTrackingDate(doc);
      add(
        payment.date,
        doc,
        {
          account: payment.accountName || accountName(payment.accountId),
          number: doc?.number,
          trackingDate: trackingDate ? displayDate(trackingDate) : '',
          principal: payment.principalAtCollection ?? (doc ? financeCents(doc.amount) : 0),
          collection: payment.amount,
          gross: recognizedCollectionRevenue(payment, financeEvents, doc),
          debtor: doc?.debtor,
          creditor: client?.tradeName || client?.name,
          staff:
            payment.turnoverStaffName || payment.collectionStaffName || person?.name || doc?.relatedStaffName,
          status: doc ? debtorStatus(doc) : '',
          department: person?.department,
        },
        { staffId, accountId: payment.accountId || '', documentId: doc?.id },
      );
    }
  }
  if (type === 'clientPayouts')
    for (const e of accounting.entries.filter((e) => e.type === 'clientPayout')) {
      const d = db.docs.find((d) => d.id === e.documentId);
      add(
        e.date,
        d,
        {
          ...(d ? basic(d) : {}),
          account: e.accountName || accountName(e.accountId),
          staff: e.operatorName || staffName(e.operatorId),
          amount: e.amount,
          note: e.note,
        },
        { staffId: e.operatorId || '', accountId: e.accountId },
      );
    }
  if (type === 'documents')
    for (const d of db.docs) {
      const f = docFinance(d);
      add(d.created, d, {
        ...basic(d),
        type: docType(d),
        status: debtorStatus(d),
        original: d.originalDocument || 'Belirtilmedi',
        staff: staffName(d.relatedStaff),
        principal: f.principal,
        total: f.target,
        received: f.received,
        remaining: f.remaining,
        profit: borrowerProfit(d),
      });
    }
  if (type === 'finance') {
    for (const e of financeEvents) {
      const d = db.docs.find((d) => d.id === e.documentId),
        payment = e.type === 'payment',
        expense = ['expense', 'costOnly'].includes(e.type) ? e.amount : 0,
        revenue = payment ? recognizedEventRevenue(e) : 0;
      add(
        e.date,
        d,
        {
          ...(d ? basic(d) : {}),
          kind: payment ? 'Tahsilat' : e.type === 'costOnly' ? 'Borca eklenmeyen masraf' : 'Borçlu masrafı',
          account: e.accountName || accountName(e.accountId),
          staff: payment
            ? e.turnoverStaffName ||
              e.collectionStaffName ||
              staffName(e.turnoverStaffId || e.collectionStaffId || d?.relatedStaff)
            : e.operatorName || staffName(e.operatorId),
          category: expense ? 'Borçlu Masrafı' : '—',
          collection: payment ? e.amount : 0,
          revenue,
          expense,
          profit: revenue - expense,
          note: e.note,
        },
        {
          staffId:
            (payment
              ? e.turnoverStaffId || e.collectionStaffId || d?.relatedStaff
              : e.operatorId || d?.relatedStaff) || '',
          accountId: e.accountId || '',
        },
      );
    }
    for (const e of accounting.entries.filter((e) => e.type === 'out' && !e.financeEventId))
      add(
        e.date,
        null,
        {
          kind: 'Muhasebe gideri',
          account: accountName(e.accountId),
          staff: e.operatorName || staffName(e.operatorId),
          category: e.expenseCategory || 'Belirtilmedi',
          collection: 0,
          revenue: 0,
          expense: e.amount,
          profit: -e.amount,
          note: e.note,
        },
        { staffId: e.operatorId || '', accountId: e.accountId },
      );
  }
  if (type === 'accounts')
    for (const e of accountMovements()) {
      const d = db.docs.find((d) => d.id === e.documentId);
      add(
        e.date,
        d,
        {
          account: accountName(e.accountId),
          kind: e.label,
          category: e.expenseCategory || '—',
          staff: e.operatorName || staffName(e.operatorId),
          incoming: Math.max(0, e.signed),
          outgoing: Math.max(0, -e.signed),
          note: e.note,
        },
        { staffId: e.operatorId || '', accountId: e.accountId },
      );
    }
  if (type === 'clientDebtorInfo')
    for (const d of db.docs) {
      const f = docFinance(d),
        payout = clientPayoutTotals(d);
      add(d.due || d.created, d, {
        status: debtorStatus(d),
        debtor: d.debtor,
        due: d.due ? displayDate(d.due) : '—',
        principal: f.principal,
        enforcement: debtorStatus(d) === 'İcra' ? 'İcra Açıldı' : '- İdari Takip',
        identity: d.identity || '—',
        sgk:
          [d.sgkStatus, d.sgkStatus === 'Var' ? d.sgkDetails : ''].filter(Boolean).join(' · ') ||
          'Belirtilmedi',
        vehicle:
          [d.vehicleStatus, d.vehicleStatus === 'Var' ? d.vehicleDetails : ''].filter(Boolean).join(' · ') ||
          'Belirtilmedi',
        tapu:
          [d.tapuStatus, d.tapuStatus === 'Var' ? d.tapuDetails : ''].filter(Boolean).join(' · ') ||
          'Belirtilmedi',
        clientEntitlement: payout.entitlement,
        clientPaid: payout.paid,
        clientRemaining: payout.remaining,
        note: (d.conversations || [])
          .filter((c) => c.result === 'Raporlandı')
          .sort((a, b) => (a.date + 'T' + a.time).localeCompare(b.date + 'T' + b.time))
          .map((c) =>
            [displayDate(c.date), c.time, c.staffName || staffName(c.staff), c.note]
              .filter(Boolean)
              .join(' · '),
          )
          .join('\n'),
      });
    }
  if (type === 'calls')
    for (const d of db.docs)
      for (const c of d.conversations || [])
        add(
          c.date,
          d,
          {
            ...basic(d),
            time: c.time,
            staff: c.staffName || staffName(c.staff),
            result: c.result,
            note: c.note,
          },
          { staffId: c.staff },
        );
  if (type === 'installments')
    for (const d of db.docs) {
      const p = d.repaymentPlan;
      if (!p) continue;
      let paid = Math.max(0, docFinance(d).received - p.receivedAtCreation);
      p.installments.forEach((r, i) => {
        const amount = Math.min(paid, r.amount);
        paid -= amount;
        const status =
          amount === r.amount
            ? 'Ödendi'
            : r.due < businessDate()
              ? 'Gecikmiş'
              : amount
                ? 'Kısmi Ödendi'
                : 'Bekliyor';
        add(
          r.due,
          d,
          {
            ...basic(d),
            sequence: i + 1,
            method: p.method === 'equal' ? 'Eşit' : 'Manuel',
            amount: r.amount,
            paid: amount,
            remaining: r.amount - amount,
            status,
          },
          { status },
        );
      });
    }
  if (type === 'discounts')
    for (const d of db.docs)
      for (const r of d.discountHistory || [])
        add(r.date, d, { ...basic(d), before: r.before, discount: r.amount, after: r.after, note: r.reason });
  if (type === 'guarantors')
    for (const d of db.docs)
      for (const g of d.guarantors || [])
        add(g.createdAt, d, {
          ...basic(d),
          name: g.name,
          identity: g.identity,
          phone: g.phone1 || g.phone,
          phone2: g.phone2,
          city: g.city,
          district: g.district,
          address: g.address,
          tapu: g.tapuStatus || 'Belirtilmedi',
          vehicle: g.vehicleStatus || 'Belirtilmedi',
          sgk: g.sgkStatus || 'Belirtilmedi',
        });
  if (type === 'clients')
    for (const c of db.clients) {
      const docs = db.docs.filter((d) => d.client === c.id);
      add(
        c.createdAt || c.created,
        null,
        {
          name: c.name,
          category: c.clientCategory,
          type: c.type,
          identity: c.identity,
          phone: c.phone,
          city: c.city,
          district: c.district,
          count: docs.length,
          principal: docs.reduce((s, d) => s + financeCents(d.amount), 0),
          paid: docs.reduce((s, d) => s + clientPayoutTotals(d).paid, 0),
        },
        { clientId: c.id, staffId: c.collectionStaff || '' },
      );
    }
  if (type === 'personnel')
    for (const p of personnel) {
      const f = staffMoney(p);
      add(
        p.createdAt,
        null,
        {
          name: p.name,
          department: p.department,
          status: p.active ? 'Aktif' : 'Pasif',
          phone: p.phone,
          official: f.official,
          unofficial: f.unofficial,
          salary: f.salary,
          bonus: f.bonus,
          total: f.total,
        },
        { staffId: p.id, status: p.active ? 'Aktif' : 'Pasif' },
      );
    }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

function filterReportRows(rows, f) {
  return rows.filter(
    (r) =>
      (r.date ? (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to) : f.undated) &&
      (!f.client || r.clientId === f.client) &&
      (!f.staff || r.staffId === f.staff) &&
      (!f.status || r.status === f.status) &&
      (!f.account || r.accountId === f.account) &&
      normalizeSearch(Object.values(r.cells).join(' ')).includes(normalizeSearch(f.query)),
  );
}

function reportCell(row, col) {
  const value = row.cells[col[0]];
  return col[2] === 'money' ? money(Number(value || 0) / 100) : String(value ?? '—');
}

function renderReportsPage() {
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Rapor Merkezi</h2><p>Kayıtlı işlemleri süzün, yazdırın veya Excel için CSV indirin.</p></div><div class="toolbar"><button class="primary monthly-payroll-report-button" id="openMonthlyPayrollReport">Aylık Maaş ve Prim Raporu</button><button class="primary ins-report-button" id="openInsReport">İNS Raporu</button><button class="primary client-list-report-button" id="openClientListReport">Müvekkil Listesi</button><button class="primary client-debtor-report-button" id="openClientDebtorInfo">Müvekkil Borçlu Bilgi Raporu</button><button class="secondary" id="printReport">Yazdır / PDF</button><button class="primary" id="exportReport">CSV İndir</button></div></div><div class="formbody grid"><label class="field full">Rapor Türü<select id="reportType">${Object.entries(
      reportDefinitions,
    )
      .map(
        ([id, r]) =>
          `<option value="${id}" ${reportFilters.type === id ? 'selected' : ''}>${r.label}</option>`,
      )
      .join(
        '',
      )}</select></label>${field('Başlangıç Tarihi', 'reportFrom', 'date', reportFilters.from)}${field('Bitiş Tarihi', 'reportTo', 'date', reportFilters.to)}<label class="field">Müvekkil<select id="reportClient"><option value="">Tümü</option>${db.clients.map((c) => `<option value="${c.id}" ${reportFilters.client === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><label class="field">Personel<select id="reportStaff"><option value="">Tümü</option>${personnel.map((p) => `<option value="${p.id}" ${reportFilters.staff === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><label class="field">Durum<select id="reportStatus"><option value="">Tümü</option>${(reportFilters.type === 'personnel' ? ['Aktif', 'Pasif'] : reportFilters.type === 'installments' ? ['Ödendi', 'Kısmi Ödendi', 'Bekliyor', 'Gecikmiş'] : ['Derdest', 'İnfaz', 'İade', 'İcra']).map((s) => `<option ${reportFilters.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label class="field">Kasa / Banka<select id="reportAccount"><option value="">Tümü</option>${accounting.accounts.map((a) => `<option value="${a.id}" ${reportFilters.account === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label><label class="field full">Raporda Ara<input type="search" id="reportQuery" value="${esc(reportFilters.query)}" placeholder="İsim, evrak no, açıklama…"></label><label class="settings-check full"><input type="checkbox" id="reportUndated" ${reportFilters.undated ? 'checked' : ''}> Kayıt tarihi bulunmayan eski kayıtları da göster</label><button class="secondary" id="clearReportFilters">Süzgeçleri Temizle</button></div></div><div id="reportResult" style="margin-top:22px"></div>`;
  function refresh() {
    const from = document.querySelector('[name="reportFrom"]').value,
      to = document.querySelector('[name="reportTo"]').value;
    reportFilters = {
      type: $('#reportType').value,
      from,
      to,
      client: $('#reportClient').value,
      staff: $('#reportStaff').value,
      status: $('#reportStatus').value,
      account: $('#reportAccount').value,
      query: $('#reportQuery').value,
      undated: $('#reportUndated').checked,
    };
    renderReportResult();
  }
  $('#reportType').onchange = () => {
    reportFilters.type = $('#reportType').value;
    reportFilters.status = '';
    reportFilters.account = '';
    reportFilters.client = '';
    reportFilters.staff = '';
    reportsPage();
  };
  for (const id of ['reportClient', 'reportStaff', 'reportStatus', 'reportAccount', 'reportUndated'])
    $('#' + id).onchange = refresh;
  document.querySelector('[name="reportFrom"]').onchange = refresh;
  document.querySelector('[name="reportTo"]').onchange = refresh;
  $('#reportQuery').oninput = refresh;
  $('#clearReportFilters').onclick = () => {
    reportFilters = {
      ...reportFilters,
      from: '',
      to: '',
      client: '',
      staff: '',
      status: '',
      account: '',
      query: '',
      undated: true,
    };
    reportsPage();
  };
  $('#openClientDebtorInfo').onclick = () => {
    reportFilters = {
      ...reportFilters,
      type: 'clientDebtorInfo',
      from: '',
      to: '',
      client: '',
      staff: '',
      status: '',
      account: '',
      query: '',
    };
    reportsPage();
  };
  $('#openMonthlyPayrollReport').onclick = monthlyPayrollReportPage;
  $('#openInsReport').onclick = insReportPage;
  $('#openClientListReport').onclick = clientListReportPage;
  $('#exportReport').onclick = exportReport;
  $('#printReport').onclick = printReport;
  renderReportResult();
}

function buildCurrentReport() {
  if (reportFilters.from && reportFilters.to && reportFilters.from > reportFilters.to)
    throw Error('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  return {
    definition: reportDefinitions[reportFilters.type],
    rows: filterReportRows(reportRows(reportFilters.type), reportFilters),
  };
}

function reportTable(def, rows, openableDocuments) {
  const renderCell = (row, column) => {
    const value = esc(reportCell(row, column));
    if (column[0] === 'debtor' && openableDocuments?.has(row.documentId)) {
      return (
        '<button type="button" class="link" data-report-borrower="' +
        esc(row.documentId) +
        '">' +
        value +
        '</button>'
      );
    }
    return value;
  };
  if (def.hideDate)
    return (
      '<div class="overflow"><table><thead><tr>' +
      def.columns.map((c) => '<th>' + esc(c[1]) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows
        .map(
          (r) =>
            '<tr>' +
            def.columns
              .map((c) => '<td style="white-space:pre-line">' + esc(reportCell(r, c)) + '</td>')
              .join('') +
            '</tr>',
        )
        .join('') +
      '</tbody><tfoot><tr>' +
      def.columns
        .map(
          (c, i) =>
            '<td>' +
            (i === 0
              ? 'TOPLAM'
              : c[2] === 'money'
                ? money(rows.reduce((sum, r) => sum + Number(r.cells[c[0]] || 0), 0) / 100)
                : '') +
            '</td>',
        )
        .join('') +
      '</tr></tfoot></table></div>'
    );
  return `<div class="overflow"><table><thead><tr><th>TARİH</th>${def.columns.map((c) => `<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><td>${r.date ? displayDate(r.date) : 'Tarih yok'}</td>${def.columns.map((c) => `<td>${renderCell(r, c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${def.columns.length + 1}" class="empty">Bu seçimle eşleşen kayıt yok.</td></tr>`}</tbody><tfoot><tr><td><b>TOPLAM</b></td>${def.columns.map((c) => `<td>${c[2] === 'money' ? '<b>' + money(rows.reduce((s, r) => s + Number(r.cells[c[0]] || 0), 0) / 100) + '</b>' : ''}</td>`).join('')}</tr></tfoot></table></div>`;
}

function renderReportResult() {
  try {
    const { definition, rows } = currentReport();
    const result = $('#reportResult');
    const openableDocuments =
      reportFilters.type === 'excel' ? new Set(db.docs.map((doc) => doc.id)) : undefined;
    result.innerHTML = `<div class="notice">${rows.length} kayıt · Tarihsiz: ${rows.filter((r) => !r.date).length}. Finansal raporlar işlem tarihini, evrak raporu kayıt tarihini, taksit raporu vade tarihini esas alır. Transferler hesap hareketlerinde giriş ve çıkış olarak görünür; kâr raporunda yer almaz. Personel maaş raporu kayıtlı güncel tutarlardır, dönem bordrosu değildir.</div><div class="panel"><div class="panelhead"><h2>${definition.label}</h2></div>${reportTable(definition, rows, openableDocuments)}</div>`;
    result.querySelectorAll('[data-report-borrower]').forEach((button) => {
      button.onclick = () => borrowerDetail(button.dataset.reportBorrower);
    });
  } catch (error) {
    $('#reportResult').textContent = error.message;
  }
}

function safeCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportReport() {
  try {
    const { definition, rows } = currentReport(),
      lines = [
        ...(definition.hideDate
          ? [
              [...definition.columns.map((c) => c[1])],
              ...rows.map((r) => definition.columns.map((c) => reportCell(r, c))),
            ]
          : [
              [definition.dateHeader || 'Tarih', ...definition.columns.map((c) => c[1])],
              ...rows.map((r) => [
                r.date ? displayDate(r.date) : 'Tarih yok',
                ...definition.columns.map((c) =>
                  definition.dateHeader && c[2] === 'money'
                    ? (Number(r.cells[c[0]] || 0) / 100).toFixed(2).replace('.', ',')
                    : reportCell(r, c),
                ),
              ]),
            ]),
      ],
      blob = new Blob(['\uFEFF' + lines.map((line) => line.map(safeCsvCell).join(';')).join('\r\n')], {
        type: 'text/csv;charset=utf-8;',
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = 'hanhukuk-' + reportFilters.type + '-' + businessDate() + '.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(error.message);
  }
}

function printReport() {
  try {
    const { definition, rows } = currentReport(),
      frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
    document.body.append(frame);
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc = `<!doctype html><html lang="tr"><meta charset="utf-8"><title>${esc(definition.label)}</title><style>body{font:10px Arial;color:#182b3a}table{border-collapse:collapse;width:100%}td,th{padding:6px;border:1px solid #ccc;text-align:left;overflow-wrap:anywhere}th{background:#eef2f5}@page{size:A4 landscape;margin:10mm}</style><h1>hanhukuk 1.1.1 · ${esc(definition.label)}</h1><p>${reportFilters.from ? displayDate(reportFilters.from) : 'Başlangıç yok'} – ${reportFilters.to ? displayDate(reportFilters.to) : 'Bitiş yok'} · ${rows.length} kayıt · Oluşturma: ${displayDate(businessDate())}</p>${reportTable(definition, rows)}</html>`;
  } catch (error) {
    toast(error.message);
  }
}

function insPersonnelRows(events, staff, docs, period, date, endDate) {
  const matches = (value) =>
    endDate
      ? String(value || '').slice(0, 10) >= date && String(value || '').slice(0, 10) <= endDate
      : String(value || '').slice(0, period === 'year' ? 4 : period === 'month' ? 7 : 10) ===
        date.slice(0, period === 'year' ? 4 : period === 'month' ? 7 : 10);
  const rows = staff.map((p) => ({
    id: p.id,
    name: p.name,
    collected: 0,
    closedCount: 0,
    closedAmount: 0,
    closedIds: new Set(),
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const e of events) {
    if (e.type !== 'payment' || !matches(e.date)) continue;
    const d = docs.find((d) => d.id === e.documentId);
    const id = e.turnoverStaffId || e.collectionStaffId || d?.relatedStaff || 'unassigned';
    let row = byId.get(id);
    if (!row) {
      row = {
        id,
        name: e.turnoverStaffName || e.collectionStaffName || d?.relatedStaffName || 'Personel atanmamış',
        collected: 0,
        closedCount: 0,
        closedAmount: 0,
        closedIds: new Set(),
      };
      byId.set(id, row);
      rows.push(row);
    }
    row.collected += Number(e.amount || 0);
    if (e.closes && !row.closedIds.has(e.documentId || e.id)) {
      row.closedIds.add(e.documentId || e.id);
      row.closedCount++;
      row.closedAmount += Number(e.closedAmount || e.amount || 0);
    }
  }
  return rows
    .map(({ closedIds, ...row }) => row)
    .sort((a, b) => b.collected - a.collected || a.name.localeCompare(b.name, 'tr'));
}

function renderInsReportPage() {
  insDate = insDate || businessDate();
  insEndDate = insEndDate || insDate;
  const rows = insPersonnelRows(financeEvents, personnel, db.docs, insPeriod, insDate, insEndDate).sort(
      (a, b) => b[insSort] - a[insSort] || b.collected - a.collected || a.name.localeCompare(b.name, 'tr'),
    ),
    total = rows.reduce(
      (s, r) => ({
        collected: s.collected + r.collected,
        closedCount: s.closedCount + r.closedCount,
        closedAmount: s.closedAmount + r.closedAmount,
      }),
      { collected: 0, closedCount: 0, closedAmount: 0 },
    );
  const chart = (key, title, format) => {
    const max = Math.max(1, ...rows.map((r) => r[key]));
    return (
      '<section class="ins-chart"><h3>' +
      title +
      '</h3>' +
      rows
        .map(
          (r) =>
            '<div class="ins-chart-row"><span>' +
            esc(r.name) +
            '</span><div class="ins-chart-track"><div class="ins-chart-bar" style="width:' +
            Math.max(0, (r[key] / max) * 100) +
            '%"></div></div><strong>' +
            format(r[key]) +
            '</strong></div>',
        )
        .join('') +
      '</section>'
    );
  };
  $('#content').innerHTML =
    '<div class="panel"><div class="panelhead"><div><h2>İNS Raporu</h2><p>Tüm personellerin tahsilat ve infaz performansı · Dosyanın tahsilat anındaki sorumlusuna göre</p></div><button class="secondary" id="backToReports">Raporlara Dön</button></div><div class="formbody"><div class="segments">' +
    [
      ['day', 'Günlük'],
      ['month', 'Aylık'],
      ['year', 'Yıllık'],
    ]
      .map(
        ([key, label]) =>
          '<button type="button" data-ins-period="' +
          key +
          '" class="' +
          (key === insPeriod ? 'selected' : '') +
          '">' +
          label +
          '</button>',
      )
      .join('') +
    '</div>' +
    '<div class="grid">' +
    field('Başlangıç Tarihi', 'insDate', 'date', insDate, true) +
    field('Bitiş Tarihi', 'insEndDate', 'date', insEndDate, true) +
    '<label class="field">Sıralama<select id="insSort">' +
    [
      ['collected', 'Tahsilat — Yüksekten Düşüğe'],
      ['closedCount', 'İnfaz Adedi — Yüksekten Düşüğe'],
      ['closedAmount', 'İnfaz Tutarı — Yüksekten Düşüğe'],
    ]
      .map(
        ([key, label]) =>
          '<option value="' + key + '" ' + (insSort === key ? 'selected' : '') + '>' + label + '</option>',
      )
      .join('') +
    '</select></label></div><p>Seçilen tarih aralığı: <strong>' +
    displayDate(insDate) +
    ' – ' +
    displayDate(insEndDate) +
    '</strong></p><div class="overflow"><table><thead><tr><th>PERSONEL</th><th>TAHSİLAT</th><th>İNFAZ ADEDİ</th><th>İNFAZ TUTARI</th></tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          '<tr><td>' +
          esc(r.name) +
          '</td><td>' +
          money(r.collected / 100) +
          '</td><td>' +
          r.closedCount +
          '</td><td>' +
          money(r.closedAmount / 100) +
          '</td></tr>',
      )
      .join('') +
    '</tbody><tfoot><tr><th>TOPLAM</th><th>' +
    money(total.collected / 100) +
    '</th><th>' +
    total.closedCount +
    '</th><th>' +
    money(total.closedAmount / 100) +
    '</th></tr></tfoot></table></div><p>İnfaz tutarı, seçilen dönemde tamamen kapatılan dosyaların toplam tutarıdır.</p><div class="ins-charts">' +
    chart('collected', 'Tahsilat Grafiği', (v) => money(v / 100)) +
    chart('closedCount', 'İnfaz Adedi Grafiği', (v) => String(v)) +
    chart('closedAmount', 'İnfaz Tutarı Grafiği', (v) => money(v / 100)) +
    '</div></div></div>';
  $('#backToReports').onclick = reportsPage;
  $('#insSort').onchange = (e) => {
    insSort = e.target.value;
    insReportPage();
  };
  document.querySelectorAll('[data-ins-period]').forEach(
    (b) =>
      (b.onclick = () => {
        insPeriod = b.dataset.insPeriod;
        const anchor = insDate;
        if (insPeriod === 'day') {
          insEndDate = anchor;
        } else if (insPeriod === 'month') {
          insDate = anchor.slice(0, 7) + '-01';
          const [y, m] = anchor.split('-').map(Number);
          insEndDate = anchor.slice(0, 7) + '-' + new Date(Date.UTC(y, m, 0)).getUTCDate();
        } else {
          insDate = anchor.slice(0, 4) + '-01-01';
          insEndDate = anchor.slice(0, 4) + '-12-31';
        }
        insReportPage();
      }),
  );
  function refreshInsRange() {
    const from = document.querySelector('[name="insDate"]'),
      to = document.querySelector('[name="insEndDate"]');
    to.setCustomValidity('');
    if (!from.value || !to.value) return;
    if (from.value > to.value) {
      to.setCustomValidity('Bitiş tarihi başlangıç tarihinden önce olamaz.');
      to.reportValidity();
      return;
    }
    insDate = from.value;
    insEndDate = to.value;
    insReportPage();
  }
  document.querySelector('[name="insDate"]').onchange = refreshInsRange;
  document.querySelector('[name="insEndDate"]').onchange = refreshInsRange;
}

function clientListReportRows(clients) {
  return clients
    .map((c) => ({
      name: c.fullName ?? (!c.type || c.type === 'Şahıs' ? c.name : ''),
      category: c.clientCategory || '',
      tradeName: c.tradeName ?? (c.type && c.type !== 'Şahıs' ? c.name : ''),
      city: c.city || '',
      district: c.district || '',
    }))
    .sort((a, b) => (a.name || a.tradeName || '').localeCompare(b.name || b.tradeName || '', 'tr'));
}

function renderClientListReportPage() {
  const rows = clientListReportRows(db.clients),
    columns = [
      ['name', 'Müvekkil Adı'],
      ['category', 'Müvekkil Türü'],
      ['tradeName', 'Müvekkil Unvanı'],
      ['city', 'İl'],
      ['district', 'İlçe'],
    ],
    table =
      '<table><thead><tr>' +
      columns.map(([, title]) => '<th>' + title + '</th>').join('') +
      '</tr></thead><tbody>' +
      (rows
        .map((r) => '<tr>' + columns.map(([key]) => '<td>' + esc(r[key] || '—') + '</td>').join('') + '</tr>')
        .join('') || '<tr><td colspan="5" class="empty">Kayıtlı müvekkil bulunmuyor.</td></tr>') +
      '</tbody></table>';
  $('#content').innerHTML =
    '<div class="panel"><div class="panelhead"><div><h2>Müvekkil Listesi</h2><p>' +
    rows.length +
    ' müvekkil · ' +
    displayDate(businessDate()) +
    '</p></div><div class="toolbar"><button class="secondary" id="clientListBack">Raporlara Dön</button><button class="secondary" id="clientListPrint">Yazdır / PDF</button><button class="primary client-list-report-button" id="clientListCsv">CSV İndir</button></div></div><div class="overflow">' +
    table +
    '</div><div class="tablefoot">Toplam ' +
    rows.length +
    ' müvekkil</div></div>';
  $('#clientListBack').onclick = reportsPage;
  $('#clientListCsv').onclick = () => {
    const lines = [columns.map(([, title]) => title), ...rows.map((r) => columns.map(([key]) => r[key]))],
      blob = new Blob(['\uFEFF' + lines.map((line) => line.map(safeCsvCell).join(';')).join('\r\n')], {
        type: 'text/csv;charset=utf-8;',
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = 'muvekkil-listesi-' + businessDate() + '.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('#clientListPrint').onclick = () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
    document.body.append(frame);
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc =
      '<!doctype html><html lang="tr"><meta charset="utf-8"><title>Müvekkil Listesi</title><style>body{font:12px Arial}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#eee}@page{size:A4 landscape;margin:12mm}</style><h1>hanhukuk 1.1.1 · Müvekkil Listesi</h1><p>' +
      displayDate(businessDate()) +
      ' · ' +
      rows.length +
      ' müvekkil</p>' +
      table +
      '</html>';
  };
}

function withReportData(callback) {
  if (!reportDataSnapshot || ['ceo', 'admin'].includes(hanAuth.role)) return callback();
  const previous = { db, personnel, financeEvents, accounting };
  try {
    db = reportDataSnapshot.db;
    personnel = reportDataSnapshot.personnel;
    financeEvents = reportDataSnapshot.financeEvents;
    accounting = reportDataSnapshot.accounting;
    return callback();
  } finally {
    db = previous.db;
    personnel = previous.personnel;
    financeEvents = previous.financeEvents;
    accounting = previous.accounting;
  }
}

function reportsPage() {
  if (!['ceo', 'admin'].includes(hanAuth.role)) {
    try {
      reportDataSnapshot = authApi('/api/report-data');
    } catch (error) {
      return toast(error.message);
    }
  }
  return withReportData(renderReportsPage);
}

function currentReport() {
  return withReportData(buildCurrentReport);
}

function insReportPage() {
  return withReportData(renderInsReportPage);
}

function clientListReportPage() {
  return withReportData(renderClientListReportPage);
}

function monthlyPayrollReportPage() {
  monthlyPayrollReportMonth = monthlyPayrollReportMonth || businessDate().slice(0, 7);
  let data;
  try {
    data = authApi('/api/payroll-report?month=' + monthlyPayrollReportMonth);
  } catch (error) {
    return toast(error.message);
  }
  const columns = [
      ['name', 'Personel'],
      ['department', 'Birim'],
      ['salary', 'Maaş'],
      ['bonus1', 'Prim 1'],
      ['bonus2', 'Prim 2'],
      ['dailyBonus', 'Günlük Prim'],
      ['total', 'Genel Toplam'],
    ],
    totals = data.rows.reduce(
      (s, r) => {
        for (const key of ['salary', 'bonus1', 'bonus2', 'dailyBonus', 'total']) s[key] += r[key];
        return s;
      },
      { salary: 0, bonus1: 0, bonus2: 0, dailyBonus: 0, total: 0 },
    ),
    table =
      '<table><thead><tr>' +
      columns.map(([, label]) => '<th>' + label + '</th>').join('') +
      '</tr></thead><tbody>' +
      data.rows
        .map(
          (r) =>
            '<tr>' +
            columns
              .map(([key], i) => '<td>' + esc(i < 2 ? r[key] || '—' : money(r[key] / 100)) + '</td>')
              .join('') +
            '</tr>',
        )
        .join('') +
      '</tbody><tfoot><tr><th colspan="2">ALT TOPLAM</th>' +
      ['salary', 'bonus1', 'bonus2', 'dailyBonus', 'total']
        .map((key) => '<th>' + money(totals[key] / 100) + '</th>')
        .join('') +
      '</tr></tfoot></table>';
  $('#content').innerHTML =
    '<div class="panel"><div class="panelhead"><div><h2>Aylık Maaş ve Prim Raporu</h2><p>' +
    data.month +
    ' · ' +
    (data.closed ? 'Geçmiş dönem' : 'Güncel dönem') +
    '</p></div><div class="toolbar"><label class="field">Rapor Ayı<input type="month" data-payroll-report-month data-optional="true" value="' +
    data.month +
    '"></label><button class="secondary" data-payroll-report-back>Raporlara Dön</button><button class="secondary" data-payroll-report-print>Yazdır / PDF</button><button class="primary" data-payroll-report-csv>CSV İndir</button></div></div>' +
    (data.missing
      ? '<div class="formbody notice">Bu ay için kayıtlı maaş ve prim dönemi bulunmuyor.</div>'
      : '') +
    '<div class="overflow">' +
    table +
    '</div><div class="formbody"><p>Prim 2 ve günlük primler yalnızca seçilen aya aittir. Geçmiş dönem maaş ve primleri dönem kaydından gösterilir.</p></div></div>';
  document.querySelector('[data-payroll-report-month]').onchange = (e) => {
    if (e.target.value) {
      monthlyPayrollReportMonth = e.target.value;
      monthlyPayrollReportPage();
    }
  };
  document.querySelector('[data-payroll-report-back]').onclick = reportsPage;
  document.querySelector('[data-payroll-report-csv]').onclick = () => {
    const lines = [
        columns.map(([, label]) => label),
        ...data.rows.map((r) => columns.map(([key], i) => (i < 2 ? r[key] || '' : money(r[key] / 100)))),
        [
          'ALT TOPLAM',
          '',
          ...['salary', 'bonus1', 'bonus2', 'dailyBonus', 'total'].map((key) => money(totals[key] / 100)),
        ],
      ],
      blob = new Blob(['\uFEFF' + lines.map((row) => row.map(safeCsvCell).join(';')).join('\r\n')], {
        type: 'text/csv;charset=utf-8;',
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'maas-prim-' + data.month + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.querySelector('[data-payroll-report-print]').onclick = () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
    document.body.append(frame);
    frame.onload = () => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60000);
    };
    frame.srcdoc =
      '<!doctype html><html lang="tr"><meta charset="utf-8"><title>Maaş ve Prim ' +
      data.month +
      '</title><style>@page{size:A4 landscape;margin:15mm}body{font:11px Arial}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:8px;text-align:left}</style><h1>Maaş ve Prim Raporu · ' +
      data.month +
      '</h1>' +
      table +
      '</html>';
  };
}

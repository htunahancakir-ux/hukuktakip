function isParkingDocument(d) {
  return d.docType === 'Yediemin Park Ücreti';
}

function validParkingRate(d) {
  return (
    d.parkingCommissionRate !== undefined &&
    d.parkingCommissionRate !== '' &&
    Number.isFinite(Number(d.parkingCommissionRate)) &&
    Number(d.parkingCommissionRate) >= 0 &&
    Number(d.parkingCommissionRate) <= 100
  );
}

function parkingCommission(amount, rate) {
  return Math.round((amount * Number(rate)) / 100);
}

function recognizedEventRevenue(event) {
  return recognizedCollectionRevenue(
    event,
    financeEvents,
    db.docs.find((d) => d.id === event.documentId),
  );
}

function borrowerProfit(d) {
  return financeEvents
    .filter((event) => event.documentId === d.id)
    .reduce(
      (total, event) =>
        total +
        (event.type === 'payment'
          ? recognizedEventRevenue(event)
          : event.type === 'expense' || event.type === 'costOnly'
            ? -event.amount
            : 0),
      0,
    );
}

function parkingCommissionMarkup(d, f) {
  if (!isParkingDocument(d)) return '';
  const rate = validParkingRate(d) ? Number(d.parkingCommissionRate) : null;
  return `<div class="notice">Yediemin dosyasında yalnızca anapara tahsil edilir. Faiz, vekâlet ücreti ve masraf borçluya eklenmez. Ofis payı anaparanın içinden ayrılır. Kısmi tahsilatta ofis payı kâra yazılmaz; yalnızca tam tahsilatla infaz olduğunda kaydedilir.</div><label class="field">% — Firma ile Anlaşılan Ofis Payı<input type="number" name="parkingCommissionRate" min="0" max="100" step="0.01" required value="${rate ?? ''}"></label>${rate !== null ? `<p>Anlaşma: %${new Intl.NumberFormat('tr-TR').format(rate)} · Anapara üzerinden toplam ofis payı: <b>${money(parkingCommission(f.principal, rate) / 100)}</b><br>İnfazda gelirleşen ofis payı: <b>${money((f.remaining === 0 ? parkingCommission(f.received, rate) : 0) / 100)}</b> · Firmaya ayrılan: <b>${money((f.received - parkingCommission(f.received, rate)) / 100)}</b></p>` : '<p>Tahsilattan önce anlaşma yüzdesini girin.</p>'}`;
}

function businessDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Baghdad',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function docFinance(d) {
  automaticLegalCharges(d);
  const events = financeEvents.filter((e) => e.documentId === d.id),
    received = events.filter((e) => e.type === 'payment').reduce((s, e) => s + e.amount, 0),
    expenses = isParkingDocument(d)
      ? 0
      : events.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0),
    grossTarget = isParkingDocument(d)
      ? financeCents(d.amount)
      : financeCents(d.amount) + financeCents(d.financeInterest) + financeCents(d.financeFee) + expenses,
    discount = Number(d.debtDiscountCents || 0),
    target = Math.max(0, grossTarget - discount);
  return {
    received,
    target,
    grossTarget,
    discount,
    expenses,
    remaining: Math.max(0, target - received),
    principal: financeCents(d.amount),
  };
}

function periodKeys(period, date) {
  if (period === 'day') return [date];
  if (period === 'year')
    return Array.from({ length: 12 }, (_, i) => date.slice(0, 4) + '-' + String(i + 1).padStart(2, '0'));
  const [y, m] = date.split('-').map(Number),
    days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => date.slice(0, 7) + '-' + String(i + 1).padStart(2, '0'));
}

function aggregateFinance(events, period, date, accountingEntries = []) {
  const costs = accountingEntries
    .filter((e) => e.type === 'out' && !e.financeEventId)
    .map((e) => ({ ...e, type: 'accountingExpense' }));
  const externalIncome = accountingEntries
    .filter((e) => e.type === 'in' && e.entryKind === 'external' && e.includeInProfit === true)
    .map((e) => ({ ...e, type: 'externalIncome' }));
  const combined = [...events, ...costs, ...externalIncome];
  const keys = periodKeys(period, date);
  return keys.map((key) => {
    const rows = combined.filter((e) => (period === 'year' ? e.date.startsWith(key) : e.date === key));
    const payment = rows.filter((e) => e.type === 'payment'),
      collected = payment.reduce((s, e) => s + e.amount, 0),
      revenue =
        payment.reduce(
          (s, e) =>
            s +
            recognizedCollectionRevenue(
              e,
              events,
              db.docs.find((d) => d.id === e.documentId),
            ),
          0,
        ) + rows.filter((e) => e.type === 'externalIncome').reduce((s, e) => s + e.amount, 0),
      expenses = rows
        .filter((e) => e.type === 'expense' || e.type === 'costOnly' || e.type === 'accountingExpense')
        .reduce((s, e) => s + e.amount, 0),
      closed = payment.filter((e) => e.closes);
    return {
      key,
      collected,
      revenue,
      expenses,
      profit: revenue - expenses,
      closedCount: closed.length,
      closedAmount: closed.reduce((s, e) => s + e.closedAmount, 0),
    };
  });
}

function openDashboardDay(date) {
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  const financeLabels = {
    payment: 'Tahsilat',
    expense: 'Dosya masrafı',
    costOnly: 'Masraf (borca eklenmedi)',
  };
  const accountingLabels = {
    in: 'Para girişi',
    out: 'Para çıkışı',
    transfer: 'Hesaplar arası transfer',
    clientPayout: 'Müvekkile anapara ödemesi',
    advance: 'Avans çıkışı',
  };
  const accounts = new Map(accounting.accounts.map((account) => [account.id, account.name]));
  const documents = new Map(db.docs.map((doc) => [doc.id, doc]));
  const rows = [
    ...financeEvents
      .filter((event) => event.date === date && Object.hasOwn(financeLabels, event.type))
      .map((event) => {
        const doc = documents.get(event.documentId);
        return {
          ...event,
          label: event.closes && event.type === 'payment' ? 'Tahsilat · İnfaz' : financeLabels[event.type],
          reference: doc ? [doc.number, doc.debtor].filter(Boolean).join(' · ') : '',
          account: event.accountName || accounts.get(event.accountId),
        };
      }),
    ...accounting.entries
      .filter((entry) => entry.date === date && !entry.financeEventId)
      .map((entry) => {
        const account = accounts.get(entry.accountId) || entry.accountName || '—';
        return {
          ...entry,
          label: entry.category || accountingLabels[entry.type] || 'Muhasebe işlemi',
          account:
            entry.type === 'transfer' ? account + ' → ' + (accounts.get(entry.destination) || '—') : account,
        };
      }),
  ].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const cells = rows
    .map((row) => {
      const details = [row.label, row.reference, row.account, row.note, money(row.amount / 100)];
      return '<tr>' + details.map((value) => '<td>' + esc(value || '—') + '</td>').join('') + '</tr>';
    })
    .join('');
  const dialog = $('#modal');
  dialog.innerHTML = `<div class="panelhead"><h2>${esc(displayDate(date))} · Günün İşlemleri</h2><button type="button" class="secondary" data-close-dashboard-day>Kapat</button></div>
    <div class="formbody overflow"><table><thead><tr><th>İŞLEM</th><th>FÖY / BORÇLU</th><th>KASA / BANKA</th><th>AÇIKLAMA</th><th>TUTAR</th></tr></thead>
    <tbody>${cells || '<tr><td colspan="5" class="empty">Bu tarihte kayıtlı işlem yok.</td></tr>'}</tbody></table></div>`;
  dialog.querySelector('[data-close-dashboard-day]').onclick = () => dialog.close();
  dialog.showModal();
}

function groupOwnerDashboardFinance() {
  if (hanAuth?.id !== 'ef14702a-dcc8-49a6-b88e-ae8311fb5a77') return;
  const content = document.getElementById('content');
  if (!content || document.getElementById('dashboardFinanceOverview')) return;
  const overview = document.createElement('section');
  overview.id = 'dashboardFinanceOverview';
  overview.append(...content.childNodes);
  content.append(overview);
}

function dashboard() {
  if (window.hanAuth && !['ceo', 'admin'].includes(hanAuth.role)) return staffDashboard();
  const buckets = aggregateFinance(financeEvents, dashboardPeriod, dashboardDate, accounting.entries),
    total = buckets.reduce(
      (a, r) => {
        for (const k of Object.keys(a)) a[k] += r[k];
        return a;
      },
      { collected: 0, revenue: 0, expenses: 0, profit: 0, closedCount: 0, closedAmount: 0 },
    );
  const f = (n) => money(n / 100);
  $('#content').innerHTML =
    `<div class="panel" style="margin-bottom:22px"><div class="panelhead"><div><h2>Gelir ve Tahsilat Özeti</h2><p>İşlem tarihine göre günlük, aylık ve yıllık takip</p></div><div class="toolbar"><label class="field">Görünüm<select id="dashboardPeriod"><option value="day" ${dashboardPeriod === 'day' ? 'selected' : ''}>Günlük</option><option value="month" ${dashboardPeriod === 'month' ? 'selected' : ''}>Aylık</option><option value="year" ${dashboardPeriod === 'year' ? 'selected' : ''}>Yıllık</option></select></label><label class="field">${dashboardPeriod === 'day' ? 'Gün' : dashboardPeriod === 'month' ? 'Ay' : 'Yıl'}<input id="dashboardDate" type="${dashboardPeriod === 'day' ? 'date' : dashboardPeriod === 'month' ? 'month' : 'number'}" value="${esc(dashboardPeriod === 'day' ? dashboardDate : dashboardPeriod === 'month' ? dashboardDate.slice(0, 7) : dashboardDate.slice(0, 4))}" ${dashboardPeriod === 'year' ? 'min="1900" max="9999"' : ''}></label></div></div></div><div class="stats">${[
      ['Tahsilat', f(total.collected)],
      ['Brüt Kâr', f(total.revenue)],
      ['Net Kâr', f(total.profit)],
      ['İnfaz Edilen Evrak', total.closedCount],
      ['İnfaz Edilen Tutar', f(total.closedAmount)],
      ['Toplam Gider', f(total.expenses)],
    ]
      .map(
        ([title, value]) =>
          `<div class="stat"><div><small>${esc(title)}</small><strong>${value}</strong></div></div>`,
      )
      .join(
        '',
      )}</div><div class="notice">Kâra eklenmesi seçilen harici para girişleri Brüt Kâr ve Kâr toplamlarına dahildir; diğer harici girişler yalnızca kasa/banka bakiyesini artırır. Tahsilat: seçilen tarihte gelen tüm kısmi ve tam ödemeler; dosyanın derdest, icra, iade veya infaz olmasına bakılmaz. Brüt Kâr: infaz tarihinde, önceki kısmi ödemeler dahil tüm tahsilatın anaparayı aşan kısmı. Net Kâr: geçmiş kısmi ödemeler dahil infaz dosyalarından hesaplanan brüt kâr eksi seçilen dönemin dosya masrafları ve muhasebe giderleri. Muhasebedeki Masraf, Faturalar, Yakıt, SGK, Maaş ve diğer para çıkışları gider toplamına dahildir. Hesaplar arası transferler gider değildir. Yediemin dosyalarında anlaşmalı ofis payı yalnızca tam tahsilatla infaz tarihinde brüt kâra ve kâra yansır; diğer dosyalarda tahsilat önce anaparaya ayrılır. Bu özet, kayıtlı gider tutarlarını kullanır; bordro veya vergi hesaplaması yapmaz. İnfaz, borcun tamamen ödendiği tarihte sayılır.</div><div class="panel"><div class="panelhead"><div><h2>${dashboardPeriod === 'year' ? 'Aylara Göre' : dashboardPeriod === 'month' ? 'Günlere Göre' : 'Günlük'} Dağılım</h2><p>Borçlu masrafları ve Muhasebe bölümündeki giderler işlem tarihine göre birlikte gösterilir.</p></div></div><div class="overflow"><table><thead><tr><th>TARİH</th><th>TAHSİLAT</th><th>BRÜT KÂR</th><th>GİDER</th><th>NET KÂR</th><th>İNFAZ ADEDİ</th><th>İNFAZ TUTARI</th></tr></thead><tbody>${buckets.map((r) => `<tr><td>${dashboardPeriod === 'year' ? esc(displayDate(r.key)) : `<button type="button" class="link" data-dashboard-day="${esc(r.key)}">${esc(displayDate(r.key))}</button>`}</td><td>${f(r.collected)}</td><td>${f(r.revenue)}</td><td>${f(r.expenses)}</td><td>${f(r.profit)}</td><td>${r.closedCount}</td><td>${f(r.closedAmount)}</td></tr>`).join('')}</tbody><tfoot><tr><td><strong>TOPLAM</strong></td>${['collected', 'revenue', 'expenses', 'profit'].map((k) => `<td><strong>${f(total[k])}</strong></td>`).join('')}<td>${total.closedCount}</td><td>${f(total.closedAmount)}</td></tr></tfoot></table></div></div>`;
  $('#content')
    .querySelectorAll('[data-dashboard-day]')
    .forEach((button) => (button.onclick = () => openDashboardDay(button.dataset.dashboardDay)));
  $('#dashboardPeriod').onchange = (e) => {
    dashboardPeriod = e.target.value;
    dashboard();
  };
  $('#dashboardDate').onchange = (e) => {
    const value = e.target.value;
    if (!value) return;
    if (dashboardPeriod === 'year') {
      if (!/^\d{4}$/.test(value) || Number(value) < 1900) return;
      dashboardDate = value + '-01-01';
    } else dashboardDate = dashboardPeriod === 'month' ? value + '-01' : value;
    dashboard();
  };
  groupOwnerDashboardFinance();
  loadPaymentPromisesHome();
}

function financialOperations(id, mode) {
  if (mode) financeOperationTab = mode;
  const d = db.docs.find((x) => x.id === id);
  if (!d) return;
  const f = docFinance(d),
    locked = financeEvents.some((e) => e.documentId === id && e.type === 'payment');
  $('#modal').innerHTML =
    `<div class="panelhead"><div><h2>${esc(d.number)} · Finansal İşlemler</h2><p><span class="debtor-name-emphasis">${esc(d.debtor)}</span> · Kalan: ${money(f.remaining / 100)} · Masraf: ${money(f.expenses / 100)}</p></div><button class="link" id="closeFinance">Kapat</button></div><form id="financeTerms"><div class="formbody"><h3 class="sectiontitle">Alacak Bileşenleri</h3>${parkingCommissionMarkup(d, f)}<button type="button" class="secondary" id="openLegalCalculator" ${locked ? 'disabled' : ''}>Vade Tarihinden Yasal Faiz ve İcra Vekâlet Ücreti Hesapla</button><p>${isParkingDocument(d) ? 'Yalnız anapara üzerinden tahsilat yapılır.' : d.legalCalculationError ? esc(d.legalCalculationError) : d.legalCalculation ? 'Yasal faiz ve icra vekâlet ücreti toplam borca dahildir. Hesap tarihi: ' + esc(displayDate(d.legalCalculation.end)) : ''}</p><p>Anapara: ${money(d.amount)} · Masraf: ${money(f.expenses / 100)} · Toplam Borç: ${money(f.target / 100)}</p><div class="grid">${field('Faiz Tutarı (₺)', 'interest', 'number', isParkingDocument(d) ? 0 : (d.financeInterest ?? 0), true)}${field('Avukatlık / Hizmet Ücreti (₺)', 'fee', 'number', isParkingDocument(d) ? 0 : (d.financeFee ?? 0), true)}</div><p>${locked ? 'Tahsilat olduğu için tutarlar kilitlidir.' : 'Faiz ve ücret tutarlarını kayıtlı evraka göre girin.'}</p></div><div class="actions"><button class="secondary" ${locked ? 'disabled' : ''}>Tutarları Kaydet</button></div></form><form id="financeEntry"><div class="formbody"><h3 class="sectiontitle">Tahsilat Kaydet</h3></div><input type="hidden" name="type" value="payment"><div class="formbody grid">${field('İşlem Tarihi', 'date', 'date', businessDate(), true, true)}${field('Tutar (₺)', 'amount', 'number', '', true)}${collectionAccountField()}${['ceo', 'admin'].includes(hanAuth.role) ? staffSelect('Ciro Personeli (isteğe bağlı)', 'turnoverStaffId').replace('<select ', '<select data-optional="true" ').replace('Personel seçin', 'Dosya sorumlusu') : ''}${field('Açıklama / Dekont No', 'note', 'text', '', true)}</div><div class="actions"><button type="button" class="secondary" id="latestCollectionReceipt" ${financeEvents.some((e) => e.documentId === id && e.type === 'payment') ? '' : 'disabled'}>Tahsilat Makbuzu</button><button class="primary">İşlemi Kaydet</button></div></form><form id="expenseEntry"><div class="formbody"><h3 class="sectiontitle">Masraf Ekle</h3><p>Toplam kayıtlı masraf: <b>${money(f.expenses / 100)}</b></p><div class="notice">Borca Eklemeden Kaydet yalnızca masraf kaydı oluşturur. Masrafı Borca Ekle toplam ve kalan borcu artırır.</div><input type="hidden" name="type" value="expense"><div class="grid">${field('Masraf Tarihi', 'date', 'date', businessDate(), true, true)}${field('Masraf Tutarı (₺)', 'amount', 'number', '', true)}${collectionAccountField('out')}${field('Masraf Açıklaması', 'note', 'text', '', true, true)}</div></div><div class="actions"><button type="submit" class="secondary" name="saveMode" value="costOnly">Borca Eklemeden Kaydet</button><button type="submit" class="primary" name="saveMode" value="addToDebt">Masrafı Borca Ekle</button></div></form>${financeHistoryMarkup(id)}`;
  setupFinanceOperationTabs();
  bindFinanceHistory();
  $('#latestCollectionReceipt').onclick = () => {
    const event = financeEvents.filter((e) => e.documentId === id && e.type === 'payment').at(-1);
    if (event) openCollectionReceipt(event.id);
  };
  $('#openLegalCalculator').disabled =
    !['ceo', 'admin'].includes(hanAuth.role) || locked || isParkingDocument(d);
  $('#openLegalCalculator').onclick = () => openLegalCalculator(id);
  if (isParkingDocument(d)) $('#expenseEntry').querySelector('[value="addToDebt"]').disabled = true;
  $('#closeFinance').onclick = () => $('#modal').close();
  if (!$('#modal').open) $('#modal').showModal();
  const terms = $('#financeTerms');
  for (const el of terms.querySelectorAll('input')) {
    el.min = '0';
    el.step = '0.01';
    if (el.name === 'parkingCommissionRate') el.max = '100';
    el.disabled =
      !['ceo', 'admin'].includes(hanAuth.role) ||
      locked ||
      (isParkingDocument(d) && el.name !== 'parkingCommissionRate');
  }
  terms.onsubmit = (e) => {
    e.preventDefault();
    if (locked || !['ceo', 'admin'].includes(hanAuth.role)) return;
    const v = Object.fromEntries(new FormData(terms));
    if (isParkingDocument(d)) {
      const rate = Number(v.parkingCommissionRate);
      if (v.parkingCommissionRate === '' || !Number.isFinite(rate) || rate < 0 || rate > 100)
        return toast('Anlaşma yüzdesi 0 ile 100 arasında olmalıdır.');
      const previous = d.parkingCommissionRate;
      d.parkingCommissionRate = rate;
      try {
        save();
      } catch {
        d.parkingCommissionRate = previous;
        return toast('Oran kaydedilemedi.');
      }
      financialOperations(id);
      return toast('Anlaşma yüzdesi kaydedildi.');
    }
    const a = financeCents(v.interest),
      b = financeCents(v.fee);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0)
      return toast('Geçerli tutarlar girin.');
    const previous = [d.financeInterest, d.financeFee];
    d.financeInterest = a / 100;
    d.financeFee = b / 100;
    try {
      save();
    } catch {
      [d.financeInterest, d.financeFee] = previous;
      return toast('Tutarlar saklanamadı.');
    }
    financialOperations(id);
    toast('Alacak tutarları kaydedildi.');
  };
  const saveFinanceEntry = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    if (e.target.id === 'expenseEntry' && e.submitter?.value !== 'addToDebt') v.type = 'costOnly';
    if (!accounting.accounts.some((a) => a.id === v.accountId))
      return toast(
        v.type === 'payment'
          ? 'Paranın girdiği kasa/banka hesabını seçin.'
          : 'Paranın çıktığı kasa/banka hesabını seçin.',
      );
    const operator = activeOperator();
    if (v.type !== 'payment' && !operator)
      return toast('Masraf çıkışı için işlem yapan personeli üst bölümden seçin.');
    const amount = financeCents(v.amount),
      live = docFinance(d);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !v.note.trim())
      return toast('Tutar ve açıklama girin.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || v.date > businessDate())
      return toast('Geçerli bir işlem tarihi girin; gelecek tarihe işlem kaydedilemez.');
    if (v.type === 'expense' && d.status === 'İnfaz')
      return toast('İnfaz edilmiş evraka yeni masraf eklenemez.');
    if (isParkingDocument(d) && v.type === 'expense')
      return toast('Yediemin dosyasında masraf borçluya eklenemez; borca eklemeden kaydedin.');
    if (isParkingDocument(d) && v.type === 'payment' && !validParkingRate(d))
      return toast('Önce anlaşma yüzdesini girip kaydedin.');
    const prior = financeEvents
      .filter((e) => e.documentId === id)
      .map((e) => e.date)
      .sort()
      .at(-1);
    if (prior && v.date < prior) return toast('Bu evrakta son işlem tarihinden önce giriş yapılamaz.');
    if (v.type !== 'payment' && amount > accountBalance(v.accountId))
      return toast('Seçilen kasa/banka hesabında yeterli bakiye yok.');
    if (v.type === 'payment' && amount > live.remaining) return toast('Tahsilat kalan borcu aşamaz.');
    const revenuePart =
      v.type === 'payment'
        ? isParkingDocument(d)
          ? amount === live.remaining
            ? parkingCommission(live.received + amount, d.parkingCommissionRate)
            : 0
          : Math.max(0, live.received + amount - live.principal) - Math.max(0, live.received - live.principal)
        : 0;
    const closes = v.type === 'payment' && amount === live.remaining;
    const event = {
      id: crypto.randomUUID(),
      documentId: id,
      type: v.type,
      date: v.date,
      amount,
      accountId: v.accountId,
      accountName: accounting.accounts.find((a) => a.id === v.accountId).name,
      operatorId: operator?.id || null,
      operatorName: operator?.name || '',
      createdAt: new Date().toISOString(),
      note: v.note.trim(),
      revenuePart,
      principalAtCollection: live.principal,
      parkingCommissionRate: isParkingDocument(d) ? Number(d.parkingCommissionRate) : null,
      clientShare: isParkingDocument(d) && v.type === 'payment' ? amount - revenuePart : null,
      closes,
      closedAmount: closes ? live.target : 0,
    };
    if (v.type === 'payment' && v.turnoverStaffId) {
      const staff = personnel.find((person) => person.id === v.turnoverStaffId && person.active);
      if (!staff) return toast('Aktif bir ciro personeli seçin.');
      event.turnoverStaffId = staff.id;
      event.turnoverStaffName = staff.name;
    }
    financeEvents.push(event);
    try {
      localStorage.setItem('hanhukuk-finance-v1', JSON.stringify(financeEvents));
    } catch {
      financeEvents.pop();
      return toast('İşlem saklanamadı.');
    }
    if (closes) {
      d.status = 'İnfaz';
      d.closedDate = v.date;
      try {
        save();
      } catch {
        toast('Tahsilat kaydedildi; evrak durumunun saklanması başarısız.');
      }
    }
    financeHistoryTab = v.type === 'costOnly' ? 'costOnly' : 'all';
    financialOperations(id);
    stats();
    toast(closes ? 'Tahsilat kaydedildi; evrak infaz edildi.' : 'İşlem kaydedildi.');
  };
  $('#financeEntry').onsubmit = saveFinanceEntry;
  $('#expenseEntry').onsubmit = saveFinanceEntry;
}

function financeHistoryMarkup(id) {
  const entries = financeEvents.filter((e) => e.documentId === id),
    costs = entries.filter((e) => e.type === 'costOnly'),
    total = costs.reduce((sum, e) => sum + e.amount, 0);
  return (
    '<div class="formbody"><div class="settings-tabs" role="tablist" aria-label="Finansal kayıtlar"><button type="button" role="tab" id="financeHistoryAllTab" data-history="all" aria-controls="financeHistoryAll">İşlem Geçmişi</button><button type="button" role="tab" id="financeHistoryCostsTab" data-history="costOnly" aria-controls="financeHistoryCosts">Borca Eklenmeyen Masraflar (' +
    costs.length +
    ')</button></div><section id="financeHistoryAll" role="tabpanel" aria-labelledby="financeHistoryAllTab">' +
    (entries
      .slice()
      .reverse()
      .map(
        (e) =>
          '<p>' +
          esc(displayDate(e.date)) +
          ' · ' +
          (e.type === 'payment'
            ? 'Tahsilat'
            : e.type === 'costOnly'
              ? 'Masraf (borca eklenmedi)'
              : 'Borçlu Masrafı') +
          ' · <b>' +
          money(e.amount / 100) +
          '</b><br>' +
          esc(e.note) +
          (e.accountName ? '<br>Hesap: ' + esc(e.accountName) : '') +
          (e.operatorName ? ' · İşlemi yapan: ' + esc(e.operatorName) : '') +
          (e.closes ? ' · İnfaz' : '') +
          (e.type === 'payment'
            ? '<br><button type="button" class="secondary" data-collection-receipt="' +
              esc(e.id) +
              '">Tahsilat Makbuzu</button>'
            : '') +
          '</p>',
      )
      .join('') || '<p>Henüz işlem yok.</p>') +
    '</section><section id="financeHistoryCosts" role="tabpanel" aria-labelledby="financeHistoryCostsTab"><div class="notice">Borca eklenmeyen masraf toplamı: <b>' +
    money(total / 100) +
    '</b><br>Bu tutarlar borçlunun toplam ve kalan borcuna dahil değildir.</div><div class="overflow"><table><thead><tr><th>TARİH</th><th>AÇIKLAMA</th><th>TUTAR</th></tr></thead><tbody>' +
    (costs
      .slice()
      .reverse()
      .map(
        (e) =>
          '<tr><td>' +
          esc(displayDate(e.date)) +
          '</td><td>' +
          esc(e.note) +
          '</td><td>' +
          money(e.amount / 100) +
          '</td></tr>',
      )
      .join('') || '<tr><td colspan="3" class="empty">Borca eklenmeyen masraf bulunmuyor.</td></tr>') +
    '</tbody><tfoot><tr><td colspan="2"><b>TOPLAM</b></td><td><b>' +
    money(total / 100) +
    '</b></td></tr></tfoot></table></div></section></div>'
  );
}

function bindFinanceHistory() {
  document
    .querySelectorAll('[data-collection-receipt]')
    .forEach((b) => (b.onclick = () => openCollectionReceipt(b.dataset.collectionReceipt)));
  function select() {
    document.querySelectorAll('[data-history]').forEach((button) => {
      const active = button.dataset.history === financeHistoryTab;
      button.classList.toggle('selected', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.getElementById('financeHistoryAll').hidden = financeHistoryTab !== 'all';
    document.getElementById('financeHistoryCosts').hidden = financeHistoryTab !== 'costOnly';
  }
  document.querySelectorAll('[data-history]').forEach(
    (button) =>
      (button.onclick = () => {
        financeHistoryTab = button.dataset.history;
        select();
      }),
  );
  select();
}

function automaticLegalCharges(d) {
  if (typeof applyParkingFee === 'function') applyParkingFee(d, businessDate());
  if (window.hanAuth && !['ceo', 'admin'].includes(hanAuth.role)) return;
  if (d.repaymentPlan || isParkingDocument(d)) return;
  if (
    !d.due ||
    d.status === 'İade' ||
    d.status === 'İnfaz' ||
    financeEvents.some((e) => e.documentId === d.id && e.type === 'payment')
  )
    return;
  const end = businessDate();
  const principal = financeCents(d.amount);
  const key = [end, d.due, principal].join('|');
  if (d.automaticLegalKey === key) return;
  try {
    if (end < '2026-11-03' || end > legalCalculationSupportedThrough)
      throw Error('Otomatik hesap için güncel tarife ve faiz oranlarının doğrulanması gerekiyor.');
    const interest = calculateLegalInterest(principal, d.due, end);
    const base = principal + interest.amount;
    const fee = calculateEnforcementFee(base, principal, false);
    const previous = {
      interest: d.financeInterest,
      fee: d.financeFee,
      calculation: d.legalCalculation,
      key: d.automaticLegalKey,
    };
    d.financeInterest = interest.amount / 100;
    d.financeFee = fee.amount / 100;
    d.legalCalculation = {
      principal,
      start: d.due,
      end,
      interest,
      base,
      fee,
      baseMode: 'principalInterest',
      early: 'no',
      verifiedThrough: legalRateVerifiedThrough,
      tariff: 'AAÜT 03.11.2026 — madde 11',
      assumption: 'Varsayımsal icra takibi; gerçek takip açılmadı',
      automatic: true,
      calculatedAt: new Date().toISOString(),
    };
    d.automaticLegalKey = key;
    delete d.legalCalculationError;
    try {
      save();
    } catch {
      d.financeInterest = previous.interest;
      d.financeFee = previous.fee;
      d.legalCalculation = previous.calculation;
      d.automaticLegalKey = previous.key;
      d.legalCalculationError = 'Otomatik hesap kaydedilemedi; depolama alanını kontrol edin.';
    }
  } catch (error) {
    d.legalCalculationError = error.message;
  }
}

function legalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Geçerli bir tarih girin.');
  const stamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value)
    throw Error('Geçersiz tarih.');
  return stamp;
}

function calculateLegalInterest(principal, start, end) {
  legalDate(start);
  legalDate(end);
  if (!Number.isSafeInteger(principal) || principal <= 0) throw Error('Anapara geçersiz.');
  if (start < '2006-01-01' || end > legalCalculationSupportedThrough)
    throw Error('Bu tarih aralığı için doğrulanmış faiz oranı bulunmuyor.');
  if (end < start) throw Error('Hesap tarihi vadeden önce olamaz.');
  const rows = [];
  let raw = 0;
  for (const period of legalRatePeriods) {
    const from = start > period.start ? start : period.start,
      to = end < period.end ? end : period.end;
    if (to <= from) continue;
    const days = (legalDate(to) - legalDate(from)) / 86400000,
      interest = (principal * period.rate * days) / 36500;
    raw += interest;
    rows.push({ from, to, rate: period.rate, days, interest: Math.round(interest) });
  }
  return { amount: Math.round(raw), rows, days: rows.reduce((sum, r) => sum + r.days, 0) };
}

function calculateEnforcementFee(base, principal, early = false) {
  if (!Number.isSafeInteger(base) || base <= 0 || !Number.isSafeInteger(principal) || principal <= 0)
    throw Error('Ücret matrahı geçersiz.');
  let remaining = base,
    raw = 0;
  const rows = [];
  if (base <= 78125 * 100) {
    raw = 12500 * 100;
    rows.push({ amount: base, rate: null, fee: raw });
  } else
    for (const [limit, rate] of enforcementTariffBands) {
      if (!remaining) break;
      const amount = Math.min(remaining, limit * 100),
        fee = (amount * rate) / 100;
      raw += fee;
      remaining -= amount;
      rows.push({ amount, rate, fee: Math.round(fee) });
    }
  const capped = Math.min(Math.round(raw), principal),
    fee = Math.round(capped * (early ? 0.75 : 1));
  return { amount: fee, rows, capped, early };
}

function openLegalCalculator(id) {
  if (!['ceo', 'admin'].includes(hanAuth.role))
    return toast('Faiz ve avukatlık ücretini yalnızca CEO ve yönetici değiştirebilir.');
  const d = db.docs.find((x) => x.id === id);
  if (!d) return;
  if (isParkingDocument(d)) return toast('Yediemin dosyasında yalnızca anapara tahsil edilir.');
  if (financeEvents.some((e) => e.documentId === id && e.type === 'payment'))
    return toast('Tahsilat bulunan evrakta otomatik yeniden hesaplama yapılamaz.');
  let dialog = document.getElementById('legalCalculator');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'legalCalculator';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="legalCalculatorForm"><div class="panelhead"><h2>Yasal Faiz ve İcra Vekâlet Ücreti</h2><button type="button" class="link" id="closeLegal">Kapat</button></div><div class="formbody"><div class="notice">Para alacağı için icra takibi açılmış varsayımıyla ön hesap. Gerçek takip açılmaz. Başlangıç vadedir; başlangıç dahil, hesap tarihi hariç; basit faiz ve 365 gün esası kullanılır. Özel faiz veya ilam hükmü varsa bu hesabı uygulamayın. Oran doğrulama sınırı: ${esc(displayDate(legalRateVerifiedThrough))}. Tarife: 03.11.2026 AAÜT, icra takibi.</div><div class="grid">${field('Vade / Faiz Başlangıcı', 'start', 'date', d.due || '', true)}${field('Varsayımsal Takip / Hesap Tarihi', 'end', 'date', businessDate(), true)}<label class="field">Vekâlet Ücreti Matrahı<select name="baseMode"><option value="principalInterest">Anapara + hesaplanan işlemiş faiz</option><option value="principal">Yalnız anapara</option></select></label><label class="field">Ödeme Aşaması<select name="early"><option value="no">Tam ücret — ödeme süresi indirimi yok</option><option value="yes">Ödeme süresinde ödeme — dörtte üç ücret</option></select></label></div><p>Anapara: <b>${money(d.amount)}</b> · Masraflar ve vekâlet ücreti faiz matrahına alınmaz.</p><button class="secondary" type="submit">Hesaplamayı Göster</button><div id="legalCalculationOutput" style="margin-top:20px"></div><p><a href="https://mevzuat.adalet.gov.tr/mevzuat/104794" target="_blank" rel="noopener">3095 sayılı Kanun</a> · <a href="https://www.barobirlik.org.tr/dosyalar/belgeler/AvUcretTarifesi/tbb2026.pdf" target="_blank" rel="noopener">AAÜT — madde 11 ve üçüncü kısım</a> · <a href="https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB%2BTR/Main%2BMenu/Temel%2BFaaliyetler/Para%2BPolitikasi/Reeskont%2Bve%2BAvans%2BFaiz%2BOranlari?v=1.0.8" target="_blank" rel="noopener">TCMB</a></p></div></form>`;
  $('#closeLegal').onclick = () => dialog.close();
  dialog.showModal();
  const form = $('#legalCalculatorForm');
  let result = null;
  form.oninput = () => {
    result = null;
    $('#legalCalculationOutput').innerHTML = '';
  };
  form.onchange = form.oninput;
  form.onsubmit = (e) => {
    e.preventDefault();
    result = null;
    try {
      const v = Object.fromEntries(new FormData(form));
      if (v.end < '2026-11-03' || v.end > legalCalculationSupportedThrough)
        throw Error('Seçilen takip tarihi için bu AAÜT sürümü doğrulanmış değil.');
      const principal = financeCents(d.amount),
        interest = calculateLegalInterest(principal, v.start, v.end),
        base = principal + (v.baseMode === 'principalInterest' ? interest.amount : 0),
        fee = calculateEnforcementFee(base, principal, v.early === 'yes');
      result = {
        ...v,
        principal,
        interest,
        base,
        fee,
        verifiedThrough: legalRateVerifiedThrough,
        tariff: 'AAÜT 03.11.2026 — madde 11',
        assumption: 'Varsayımsal icra takibi; gerçek takip açılmadı',
        calculatedAt: new Date().toISOString(),
      };
      $('#legalCalculationOutput').innerHTML =
        `<div class="overflow"><table><thead><tr><th>DÖNEM (SON GÜN HARİÇ)</th><th>GÜN</th><th>YILLIK ORAN</th><th>FAİZ</th></tr></thead><tbody>${interest.rows.map((r) => `<tr><td>${esc(displayDate(r.from))} – ${esc(displayDate(r.to))}</td><td>${r.days}</td><td>%${r.rate}</td><td>${money(r.interest / 100)}</td></tr>`).join('')}</tbody></table></div><p>Toplam ${interest.days} gün · <b>Faiz: ${money(interest.amount / 100)}</b></p><p>Vekâlet matrahı: ${money(base / 100)} · Asıl alacak üst sınırı: ${money(principal / 100)}<br><b>İcra vekâlet ücreti: ${money(fee.amount / 100)}</b>${fee.early ? ' (dörtte üç ücret)' : ''}</p><p>Masraflar hariç toplam: <b>${money((principal + interest.amount + fee.amount) / 100)}</b></p><label class="settings-check"><input type="checkbox" id="confirmLegal">Vade başlangıcı, genel kanuni faiz, matrah ve seçilen tarifenin bu evraka uygunluğunu kontrol ettim.</label><button type="button" class="primary" id="applyLegal">Hesaplanan Faiz ve Ücreti Borca Uygula</button>`;
      $('#applyLegal').onclick = () => {
        if (!result || !$('#confirmLegal').checked)
          return toast('Hesabın evraka uygunluğunu kontrol edip işaretleyin.');
        if (financeEvents.some((e) => e.documentId === id && e.type === 'payment'))
          return toast('Bu evrakta tahsilat var; tutarlar değiştirilemez.');
        const previous = structuredClone(d);
        d.financeInterest = result.interest.amount / 100;
        d.financeFee = result.fee.amount / 100;
        d.legalCalculation = result;
        try {
          save();
        } catch {
          Object.keys(d).forEach((k) => delete d[k]);
          Object.assign(d, previous);
          return toast('Hesap kaydedilemedi.');
        }
        dialog.close();
        financialOperations(id);
        toast('Hesaplanan faiz ve vekâlet ücreti borca uygulandı.');
      };
    } catch (error) {
      $('#legalCalculationOutput').textContent = error.message;
    }
  };
}

function equalInstallments(balance, count) {
  if (
    !Number.isSafeInteger(balance) ||
    balance <= 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 120 ||
    count > balance
  )
    throw Error('Taksit sayısı 1–120 arasında olmalı; her taksit en az 1 kuruş olmalıdır.');
  const base = Math.floor(balance / count),
    remainder = balance % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function installmentMonth(first, index) {
  legalDate(first);
  const [year, month, day] = first.split('-').map(Number),
    date = new Date(Date.UTC(year, month - 1 + index, 1)),
    last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}

function repaymentSection(d) {
  const plan = d.repaymentPlan,
    f = docFinance(d);
  let paidSince = plan ? Math.max(0, f.received - plan.receivedAtCreation) : 0;
  return `<h3 class="sectiontitle" style="margin-top:30px">Borcu Yapılandır</h3>${d.status === 'İnfaz' && f.remaining === 0 ? '<div class="notice">Bu dosya infaz edilmiştir. Yapılandırma planları ve taksit geçmişi aşağıda görüntülenir; kapanmış borç için yeni plan oluşturulmaz.</div>' : ''}<div class="notice">Yapılandırılabilir kalan borç: <b>${money(f.remaining / 100)}</b>. Plan kaydetmek tahsilat oluşturmaz. Plan kaydedildiğinde mevcut faiz ve ücret tutarları sabitlenir; ek masraflar ayrıca borca yansıyabilir.</div><div class="toolbar"><button type="button" class="primary" id="openRepayment" ${f.remaining === 0 || d.status === 'İade' ? 'disabled' : ''}>${plan ? (d.repaymentPlanHistory || []).length + 2 + '. Yapılandırma Oluştur' : 'Borcu Yapılandır'}</button>${paymentPromiseButton(d)}</div>${paymentPromiseSummary(d)}${
    plan
      ? `<p>${(d.repaymentPlanHistory || []).length + 1}. Yapılandırma · Plan: <b>${esc(plan.method === 'equal' ? 'Eşit Böl' : 'Manuel Taksitlendirme')}</b> · ${plan.installments.length} taksit · Toplam ${money(plan.balance / 100)}${plan.discount ? ` · İndirim: ${money(plan.discount / 100)} · ${esc(plan.discountReason)}` : ''}</p>${f.target !== plan.targetAtCreation ? '<div class="notice">Plan oluşturulduktan sonra borç toplamı değişti. Yeni kalan borç için planı yeniden düzenleyin.</div>' : ''}<div class="overflow"><table><thead><tr><th>TAKSİT</th><th>VADE</th><th>TUTAR</th><th>TAHSİL EDİLEN</th><th>KALAN</th></tr></thead><tbody>${plan.installments
          .map((r, i) => {
            const paid = Math.min(r.amount, paidSince);
            paidSince -= paid;
            return `<tr><td>${i + 1}</td><td>${esc(displayDate(r.due))}</td><td>${money(r.amount / 100)}</td><td>${money(paid / 100)}</td><td>${money((r.amount - paid) / 100)}</td></tr>`;
          })
          .join(
            '',
          )}</tbody></table></div><p>Tahsilatlar, plan kaydından sonra girilen ödemelerden başlayarak vade sırasıyla taksitlere dağıtılır.</p>`
      : '<p>Henüz yapılandırma planı yok.</p>'
  }${repaymentHistoryMarkup(d)}`;
}

function bindRepayment(d) {
  $('#openRepayment').onclick = () => openRepayment(d);
  bindPaymentPromise(d, document.getElementById('borrowerDetail'));
}

function openRepayment(d) {
  const finance = docFinance(d);
  if (!finance.remaining || d.status === 'İade') return toast('Bu dosyada yapılandırılabilir borç yok.');
  let dialog = document.getElementById('repaymentDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'repaymentDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="repaymentForm"><div class="panelhead"><div><h2>Borcu Yapılandır</h2><p>${esc(d.debtor)} · ${esc(d.number)}</p></div><button type="button" class="secondary" id="closeRepayment">Kapat</button></div><div class="formbody"><div class="notice">Kalan borç: <b>${money(finance.remaining / 100)}</b>. Kuruş farkları eşit bölmede ilk taksitlere dağıtılır.</div><div class="grid"><label class="field">Yapılandırılacak Borç<select name="settlementMode"><option value="full">Borcun Tamamı</option><option value="discounted">İndirimli Tutar</option></select></label><label class="field">Anlaşılan Yeni Tutar (TL)<input type="text" inputmode="decimal" name="settlementAmount" data-optional="true" disabled value="${formatAmountInput(finance.remaining / 100)}"></label><label class="field full">İndirim Açıklaması<input type="text" name="discountReason" data-optional="true" disabled></label><label class="field">Yöntem<select name="method"><option value="equal">Eşit Böl</option><option value="manual">Manuel Taksitlendirme</option></select></label><label class="field">Kaç Taksit?<input type="number" name="count" min="1" max="120" step="1" value="1" required></label>${field('İlk Taksit Tarihi', 'firstDue', 'date', businessDate(), true)}</div><button type="button" class="secondary" id="generateInstallments" style="margin-top:18px">Taksitlendir</button><div id="installmentRows" style="margin-top:20px"></div></div></form>`;
  $('#closeRepayment').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  const form = $('#repaymentForm');
  let generated = null;
  function invalidate() {
    generated = null;
    $('#installmentRows').innerHTML = '';
  }
  function selectedBalance() {
    if (form.elements.settlementMode.value === 'full') return finance.remaining;
    const parsed = parseAmountInput(form.elements.settlementAmount.value),
      balance = parsed === null || parsed === '' ? NaN : financeCents(parsed);
    if (!Number.isSafeInteger(balance) || balance <= 0 || balance >= finance.remaining)
      throw Error('İndirimli tutar sıfırdan büyük ve kalan borçtan küçük olmalıdır.');
    return balance;
  }
  form.elements.settlementMode.onchange = () => {
    const discounted = form.elements.settlementMode.value === 'discounted';
    for (const name of ['settlementAmount', 'discountReason']) {
      form.elements[name].disabled = !discounted;
      form.elements[name].required = discounted;
    }
    invalidate();
  };
  form.elements.settlementAmount.oninput = invalidate;
  form.elements.settlementAmount.onblur = () => {
    const parsed = parseAmountInput(form.elements.settlementAmount.value);
    if (parsed !== null && parsed !== '') form.elements.settlementAmount.value = formatAmountInput(parsed);
  };
  form.elements.method.onchange = invalidate;
  form.elements.count.oninput = invalidate;
  form.elements.firstDue.onchange = invalidate;
  $('#generateInstallments').onclick = () => {
    try {
      const count = Number(form.elements.count.value),
        first = form.elements.firstDue.value;
      legalDate(first);
      const balance = selectedBalance(),
        amounts = equalInstallments(balance, count),
        method = form.elements.method.value;
      generated = { count, first, method, balance };
      $('#installmentRows').innerHTML =
        `<div class="overflow"><table><thead><tr><th>TAKSİT</th><th>VADE</th><th>TUTAR (TL)</th></tr></thead><tbody>${amounts.map((amount, i) => `<tr><td>${i + 1}</td><td><label class="field">${i + 1}. Taksit Vadesi<input name="due_${i}" type="date" value="${installmentMonth(first, i)}" required></label></td><td><label class="field">${i + 1}. Taksit Tutarı<input name="installmentAmount_${i}" type="text" inputmode="decimal" value="${formatAmountInput(amount / 100)}" ${method === 'equal' ? 'readonly' : ''} required></label></td></tr>`).join('')}</tbody></table></div><p id="installmentTotals" role="status" aria-live="polite"></p><button class="primary" type="submit">Yapılandırmayı Kaydet</button>`;
      form.querySelectorAll('[name^="installmentAmount_"]').forEach((input) => {
        input.oninput = updateTotals;
        input.onblur = () => {
          const parsed = parseAmountInput(input.value);
          if (parsed !== null && parsed !== '') input.value = formatAmountInput(parsed);
          updateTotals();
        };
      });
      updateTotals();
    } catch (error) {
      toast(error.message);
    }
  };
  function readRows() {
    if (!generated) throw Error('Önce Taksitlendir düğmesine basın.');
    const rows = [];
    for (let i = 0; i < generated.count; i++) {
      const raw = parseAmountInput(form.elements['installmentAmount_' + i].value),
        amount = raw === null || raw === '' ? NaN : financeCents(raw),
        due = form.elements['due_' + i].value;
      legalDate(due);
      if (!Number.isSafeInteger(amount) || amount <= 0)
        throw Error('Her taksit için sıfırdan büyük, geçerli tutar girin.');
      if (i && due < rows[i - 1].due) throw Error('Taksit vadeleri sırayla ilerlemelidir.');
      rows.push({ due, amount });
    }
    return rows;
  }
  function updateTotals() {
    try {
      const rows = readRows(),
        total = rows.reduce((s, r) => s + r.amount, 0),
        difference = generated.balance - total;
      $('#installmentTotals').textContent =
        'Taksit Toplamı: ' +
        money(total / 100) +
        ' · Yapılandırma Tutarı: ' +
        money(generated.balance / 100) +
        ' · Fark: ' +
        money(difference / 100);
    } catch (error) {
      $('#installmentTotals').textContent = error.message;
    }
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      if (
        !generated ||
        generated.count !== Number(form.elements.count.value) ||
        generated.method !== form.elements.method.value ||
        generated.first !== form.elements.firstDue.value ||
        generated.balance !== selectedBalance()
      )
        throw Error('Değişen bilgilerle yeniden Taksitlendir düğmesine basın.');
      const rows = readRows(),
        live = docFinance(d);
      if (
        live.remaining !== finance.remaining ||
        live.received !== finance.received ||
        live.target !== finance.target
      )
        throw Error('Borç tutarı değişti. Pencereyi kapatıp güncel tutarla yeniden açın.');
      if (rows.reduce((s, r) => s + r.amount, 0) !== generated.balance)
        throw Error('Taksit toplamı seçilen yapılandırma tutarına eşit olmalıdır.');
      const discount = live.remaining - generated.balance,
        reason = form.elements.discountReason.value.trim();
      if (discount > 0 && !reason) throw Error('İndirim açıklamasını girin.');
      persistRepaymentPlan(d, {
        method: generated.method,
        balance: generated.balance,
        discount,
        discountReason: reason,
        originalBalance: live.remaining,
        targetAtCreation: live.target - discount,
        receivedAtCreation: live.received,
        installments: rows,
      });
      dialog.close();
      borrowerDetail(d.id);
      toast('Yapılandırma planı kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
}

function clientPayoutClosureDate(d) {
  return (
    d.closedDate ||
    financeEvents
      .filter((e) => e.documentId === d.id && e.type === 'payment' && e.closes)
      .map((e) => e.date)
      .sort()
      .at(-1) ||
    ''
  );
}

function matchesPayoutDate(d, start, end) {
  const date = clientPayoutClosureDate(d);
  return (!start && !end) || (!!date && (!start || date >= start) && (!end || date <= end));
}

function clientPayoutTotals(d) {
  const rows = accounting.entries.filter((e) => e.type === 'clientPayout' && e.documentId === d.id),
    paid = financeCents(d.clientPaidAmount) + rows.reduce((s, e) => s + e.amount, 0),
    f = docFinance(d),
    eligible = d.status === 'İnfaz' && f.remaining === 0;
  let entitlement = f.principal;
  if (isParkingDocument(d))
    entitlement = validParkingRate(d)
      ? Math.max(0, f.received - parkingCommission(f.received, d.parkingCommissionRate))
      : 0;
  return { rows, paid, entitlement, remaining: Math.max(0, entitlement - paid), eligible };
}

function clientPayoutSection(d) {
  const p = clientPayoutTotals(d);
  return `<h3 class="sectiontitle" style="margin-top:30px">Müvekkile Ödeme</h3><div class="grid"><div class="detail-field"><small>Müvekkile Ödenecek ${isParkingDocument(d) ? 'Firma Payı' : 'Anapara'}</small><b>${money(p.entitlement / 100)}</b></div><div class="detail-field"><small>Müvekkile Ödenen</small><b>${money(p.paid / 100)}</b></div><div class="detail-field"><small>Müvekkile Kalan Ödeme</small><b>${money(p.remaining / 100)}</b></div></div><p>Bu ödeme kasadan/bankadan çıkar; gider veya kâr hesabına dahil edilmez.${isParkingDocument(d) ? ' Yediemin dosyasında anlaşmalı ofis payı düşülerek firma payı ödenir.' : ''}</p><button class="primary" type="button" id="payClientFromBorrower" ${!p.eligible || !p.remaining ? 'disabled' : ''}>Müvekkile Ödeme Kaydet</button>${!p.eligible ? '<p>Ödeme için dosyanın infaz olması ve borçlu bakiyesinin kapanması gerekir.</p>' : ''}${p.rows.map((e) => `<p>${esc(displayDate(e.date))} · ${money(e.amount / 100)} · ${esc(e.accountName || '')} · ${esc(e.operatorName || '')}<br>${esc(e.note)}</p>`).join('')}`;
}

function bindClientPayout(d) {
  $('#payClientFromBorrower').onclick = () => clientPayoutForm(d.id);
}

function syncPayoutSources() {
  const ledger = JSON.parse(localStorage.getItem('hanhukuk-accounting-v1') || 'null'),
    events = JSON.parse(localStorage.getItem('hanhukuk-finance-v1') || 'null'),
    records = JSON.parse(localStorage.getItem('icrapro-v1') || 'null');
  if (ledger && Array.isArray(ledger.accounts) && Array.isArray(ledger.entries)) accounting = ledger;
  if (Array.isArray(events)) financeEvents = events;
  if (records && Array.isArray(records.clients) && Array.isArray(records.docs)) db = records;
}

let clientPayoutExtraFilters = {
  debtor: '',
  identity: '',
  number: '',
  type: '',
  staff: '',
  minAmount: '',
  maxAmount: '',
  minCents: '',
  maxCents: '',
  paymentState: '',
};
function matchesClientPayoutExtra(d, p, f) {
  return (
    (!f.debtor || normalizeSearch(d.debtor || '').includes(normalizeSearch(f.debtor.trim()))) &&
    (!f.identity || String(d.identity || '').includes(f.identity.trim())) &&
    (!f.number || normalizeSearch(d.number || '').includes(normalizeSearch(f.number.trim()))) &&
    (!f.type || docType(d) === f.type) &&
    (!f.staff || (f.staff === 'unassigned' ? !d.relatedStaff : d.relatedStaff === f.staff)) &&
    (f.minCents === '' || p.remaining >= Number(f.minCents)) &&
    (f.maxCents === '' || p.remaining <= Number(f.maxCents)) &&
    (!f.paymentState || (f.paymentState === 'partial' ? p.paid > 0 : p.paid === 0))
  );
}
function clientPayoutFilterMarkup() {
  const f = clientPayoutExtraFilters;
  const input = (label, name, type = 'text', value = f[name]) =>
    '<label class="field">' +
    label +
    '<input name="' +
    name +
    '" type="' +
    type +
    '" data-optional="true" value="' +
    esc(value || '') +
    '"></label>';
  const options = (rows, value) =>
    rows
      .map(
        ([id, label]) =>
          '<option value="' +
          esc(id) +
          '" ' +
          (value === id ? 'selected' : '') +
          '>' +
          esc(label) +
          '</option>',
      )
      .join('');
  return (
    '<details class="borrower-filter-section" id="clientPayoutFilterSection"' +
    (document.getElementById('clientPayoutFilterSection')?.open ? ' open' : '') +
    '><summary>Filtreleme</summary><form id="clientPayoutDateForm" class="formbody"><div class="grid">' +
    '<label class="field">Müvekkil<select name="client" id="clientPayoutFilter" data-optional="true">' +
    options([['', 'Tüm Müvekkiller'], ...db.clients.map((c) => [c.id, c.name])], clientPayoutFilter) +
    '</select></label>' +
    input('İnfaz Tarihi — Başlangıç', 'start', 'date', clientPayoutStart) +
    input('İnfaz Tarihi — Bitiş', 'end', 'date', clientPayoutEnd) +
    input('Borçlu Adı', 'debtor') +
    input('TC Kimlik / Vergi No', 'identity') +
    input('Evrak No', 'number') +
    '<label class="field">Evrak Türü<select name="type" data-optional="true">' +
    options([['', 'Tüm Evrak Türleri'], ...Object.keys(documentTypes).map((t) => [t, t])], f.type) +
    '</select></label>' +
    '<label class="field">Dosya Sorumlusu<select name="staff" data-optional="true">' +
    options(
      [
        ['', 'Tüm Personeller'],
        ['unassigned', 'Atanmamış'],
        ...personnel.map((p) => [p.id, p.name + (p.active ? '' : ' (pasif)')]),
      ],
      f.staff,
    ) +
    '</select></label>' +
    input('En Az Ödenecek Tutar (TL)', 'minAmount') +
    input('En Çok Ödenecek Tutar (TL)', 'maxAmount') +
    '<label class="field">Ödeme Durumu<select name="paymentState" data-optional="true">' +
    options(
      [
        ['', 'Ödemesi Bekleyen Tüm Dosyalar'],
        ['unpaid', 'Hiç Ödeme Yapılmamış'],
        ['partial', 'Kısmen Ödenmiş'],
      ],
      f.paymentState,
    ) +
    '</select></label>' +
    '</div><div class="toolbar" style="margin-top:16px"><button type="submit" class="primary">Filtrele</button><button type="button" class="secondary" id="clearPayoutDates">Tüm Filtreleri Temizle</button></div><p>Başlangıç ve bitiş günleri dahildir. Tarih filtresi açıkken infaz tarihi bulunmayan dosyalar gösterilmez.</p></form></details>'
  );
}
function clientPayoutPage() {
  try {
    syncPayoutSources();
  } catch {
    return toast('Ödeme kayıtları okunamadı.');
  }
  const list = db.docs
    .map((d) => ({ d, p: clientPayoutTotals(d) }))
    .filter(
      ({ d, p }) =>
        p.eligible &&
        p.remaining > 0 &&
        matchesPayoutDate(d, clientPayoutStart, clientPayoutEnd) &&
        (!clientPayoutFilter || d.client === clientPayoutFilter) &&
        matchesClientPayoutExtra(d, p, clientPayoutExtraFilters),
    );
  $('#content').innerHTML =
    `<div class="panel"><div class="panelhead"><div><h2>Müvekkil Ödemeleri</h2><p>Yalnızca infaz edilmiş ve müvekkile ödemesi tamamlanmamış dosyalar.</p></div><button type="button" class="secondary" id="backAccounting">← Kasa / Banka</button></div>${clientPayoutFilterMarkup()}<div class="formbody"><div class="notice" style="margin-top:18px">Müvekkile anapara iadesi gider değildir. Seçilen hesap bakiyesi azalır; ciro ve kâr değişmez. Yediemin dosyasında anlaşmalı ofis payı ayrılır. Bu ekran ödeme kaydı tutar, bankaya havale talimatı göndermez.</div><p>${list.length} dosya · Toplam ödenecek: <b>${money(list.reduce((s, x) => s + x.p.remaining, 0) / 100)}</b></p></div><div class="overflow"><table><thead><tr><th>DOSYA</th><th>BORÇLU / MÜVEKKİL</th><th>İNFAZ TARİHİ</th><th>ANAPARA</th><th>ÖDENEN</th><th>ÖDENECEK</th><th>İŞLEM</th></tr></thead><tbody>${list.map(({ d, p }) => `<tr><td>${esc(d.number)}<small>${esc(docType(d))}</small></td><td>${esc(d.debtor)}<small>${esc(db.clients.find((c) => c.id === d.client)?.name || '—')}</small></td><td>${esc(displayDate(clientPayoutClosureDate(d)) || '—')}</td><td>${money(p.entitlement / 100)}</td><td>${money(p.paid / 100)}</td><td><b>${money(p.remaining / 100)}</b></td><td><button class="primary" type="button" data-client-payout="${esc(d.id)}">Ödeme Kaydet</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Müvekkile ödemesi bekleyen infaz dosyası bulunmuyor.</td></tr>'}</tbody><tfoot><tr><td colspan="3"><strong>ALT TOPLAM</strong></td><td><strong>${money(list.reduce((sum, x) => sum + x.p.entitlement, 0) / 100)}</strong></td><td><strong>${money(list.reduce((sum, x) => sum + x.p.paid, 0) / 100)}</strong></td><td><strong>${money(list.reduce((sum, x) => sum + x.p.remaining, 0) / 100)}</strong></td><td></td></tr></tfoot></table></div></div>`;
  $('#backAccounting').onclick = accountingPage;
  const dateForm = $('#clientPayoutDateForm');
  dateForm.onsubmit = (e) => {
    e.preventDefault();
    if (!dateForm.reportValidity()) return;
    const start = dateForm.elements.start.value,
      end = dateForm.elements.end.value;
    if (start && end && start > end) return toast('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
    const next = Object.fromEntries(new FormData(dateForm));
    for (const [name, key] of [
      ['minAmount', 'minCents'],
      ['maxAmount', 'maxCents'],
    ]) {
      const parsed = parseAmountInput(next[name]);
      if (parsed === null || (parsed !== '' && Number(parsed) < 0))
        return toast('Geçerli, sıfır veya pozitif tutar girin.');
      next[key] = parsed === '' ? '' : financeCents(parsed);
    }
    if (next.minCents !== '' && next.maxCents !== '' && next.minCents > next.maxCents)
      return toast('En az tutar, en çok tutardan büyük olamaz.');
    clientPayoutFilter = next.client;
    clientPayoutExtraFilters = next;
    clientPayoutStart = start;
    clientPayoutEnd = end;
    clientPayoutPage();
  };
  $('#clearPayoutDates').onclick = () => {
    clientPayoutFilter = '';
    for (const key of Object.keys(clientPayoutExtraFilters)) clientPayoutExtraFilters[key] = '';
    clientPayoutStart = '';
    clientPayoutEnd = '';
    clientPayoutPage();
  };
  document
    .querySelectorAll('[data-client-payout]')
    .forEach((b) => (b.onclick = () => clientPayoutForm(b.dataset.clientPayout)));
}

function configureClientPayoutAmount(form, remainingCents, onChange) {
  const amount = form.elements.amount,
    mode = form.elements.paymentMode;
  amount.min = '0.01';
  amount.max = String(remainingCents / 100);
  amount.step = '0.01';
  let partial = '';
  mode.addEventListener('change', () => {
    const full = mode.value === 'full';
    if (full) partial = amount.value;
    amount.value = full ? String(remainingCents / 100) : partial;
    amount.readOnly = full;
    if (amount._moneyProxy) {
      amount._moneyProxy.readOnly = full;
      amount._moneyProxy.value = formatAmountInput(amount.value);
      amount._moneyProxy.setCustomValidity('');
    }
    onChange();
  });
}
function clientPayoutForm(id) {
  try {
    syncPayoutSources();
  } catch {
    return toast('Kayıtlar okunamadı.');
  }
  const d = db.docs.find((d) => d.id === id);
  if (!d) return;
  const p = clientPayoutTotals(d),
    client = db.clients.find((c) => c.id === d.client);
  if (!p.eligible || !p.remaining) return toast('Bu dosyada ödenmemiş infaz anaparası yok.');
  let dialog = document.getElementById('clientPayoutDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'clientPayoutDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="clientPayoutForm"><div class="panelhead"><div><h2>Müvekkile Ödeme Kaydet</h2><p>${esc(d.number)} · ${esc(client?.name || 'Müvekkil bulunamadı')}</p></div><button class="secondary" type="button" id="closeClientPayout">Kapat</button></div><div class="formbody"><div class="notice">Ödenecek tutar: <b>${money(p.remaining / 100)}</b>. Kayıt gider sayılmaz; seçilen hesaptan düşülür.</div><p>Banka: ${esc(client?.bankName || '—')} · Hesap sahibi: ${esc(client?.accountHolder || '—')}<br>IBAN: ${esc(client?.iban || '—')}</p><div class="grid">${collectionAccountField('out')}<label class="field">Ödeme Şekli<select name="paymentMode" data-optional="true"><option value="partial">Tutar Gir (Kısmi Ödeme)</option><option value="full">Ödemenin Tamamı</option></select></label>${field('Ödenecek Tutar (TL)', 'amount', 'number', '', true)}${field('Ödeme Tarihi', 'date', 'date', businessDate(), true)}${field('Dekont / Ödeme Açıklaması', 'note', 'text', '', true, true)}</div><p id="clientPayoutRemainingPreview" role="status" aria-live="polite"></p></div><div class="actions"><button class="primary" type="submit">Ödemeyi Kaydet</button></div></form>`;
  $('#closeClientPayout').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  const form = $('#clientPayoutForm');
  const updateRemaining = () => {
    const amount = financeCents(form.elements.amount.value);
    $('#clientPayoutRemainingPreview').textContent =
      Number.isSafeInteger(amount) && amount > 0 && amount <= p.remaining
        ? 'Bu ödeme sonrası kalan: ' + money((p.remaining - amount) / 100)
        : '0’dan büyük ve kalan tutarı aşmayan bir ödeme girin.';
  };
  configureClientPayoutAmount(form, p.remaining, updateRemaining);
  form.elements.amount.addEventListener('input', updateRemaining);
  form.elements.amount.addEventListener('change', updateRemaining);
  updateRemaining();
  const paymentRequestId = crypto.randomUUID();
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      syncPayoutSources();
      const current = db.docs.find((d) => d.id === id),
        live = current && clientPayoutTotals(current);
      if (!current || !live.eligible || !live.remaining)
        throw Error('Bu dosyanın müvekkil ödemesi tamamlanmış veya dosya artık uygun değil.');
      if (live.remaining !== p.remaining)
        throw Error('Ödeme tutarı değişti; pencereyi kapatıp yeniden açın.');
      const v = Object.fromEntries(new FormData(form)),
        paymentAmount = v.paymentMode === 'full' ? live.remaining : financeCents(v.amount),
        account = accounting.accounts.find((a) => a.id === v.accountId),
        operator = activeOperator();
      if (!Number.isSafeInteger(paymentAmount) || paymentAmount <= 0)
        throw Error('Geçerli, sıfırdan büyük bir ödeme tutarı girin.');
      if (paymentAmount > live.remaining) throw Error('Ödeme tutarı müvekkile kalan tutarı aşamaz.');
      if (!operator) throw Error('Üst bölümden işlem yapan personeli seçin.');
      if (!account) throw Error('Paranın çıktığı hesabı seçin.');
      legalDate(v.date);
      if (v.date > businessDate()) throw Error('Gelecek tarihe gerçekleşmiş ödeme girilemez.');
      if (current.closedDate && v.date < current.closedDate)
        throw Error('Ödeme tarihi infaz tarihinden önce olamaz.');
      if (!v.note.trim()) throw Error('Ödeme açıklamasını girin.');
      if (accountBalance(account.id) < paymentAmount) throw Error('Seçilen hesapta yeterli bakiye yok.');
      authApi('/api/client-payout', 'POST', {
        id: paymentRequestId,
        type: 'clientPayout',
        documentId: current.id,
        clientId: current.client,
        amount: paymentAmount,
        accountId: account.id,
        accountName: account.name,
        operatorId: operator.id,
        operatorName: operator.name,
        date: v.date,
        note: v.note.trim(),
        createdAt: new Date().toISOString(),
      });
      dialog.close();
      try {
        syncPayoutSources();
      } catch {
        toast('Ödeme kaydedildi. Güncel bakiyeyi görmek için sayfayı yenileyin.');
        return;
      }
      const borrower = document.getElementById('borrowerDetail');
      if (borrower?.open) borrowerDetail(id);
      if (page === 'accounting') clientPayoutPage();
      else if (page === 'clients') render();
      else stats();
      toast(
        paymentAmount < live.remaining
          ? 'Kısmi müvekkil ödemesi kaydedildi.'
          : 'Müvekkil ödemesi tamamlandı.',
      );
    } catch (error) {
      toast(error.message);
    }
  };
}

function persistRepaymentPlan(d, plan) {
  const before = structuredClone(d);
  if (plan.discount > 0) {
    d.debtDiscountCents = Number(d.debtDiscountCents || 0) + plan.discount;
    d.discountHistory = [
      ...(d.discountHistory || []),
      {
        amount: plan.discount,
        reason: plan.discountReason,
        date: new Date().toISOString(),
        before: plan.originalBalance,
        after: plan.balance,
      },
    ];
  }
  if (d.repaymentPlan)
    d.repaymentPlanHistory = [...(d.repaymentPlanHistory || []), structuredClone(d.repaymentPlan)];
  d.repaymentPlan = { ...plan, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  try {
    save();
  } catch {
    Object.keys(d).forEach((k) => delete d[k]);
    Object.assign(d, before);
    throw Error('Yapılandırma kaydedilemedi.');
  }
}

function repaymentHistoryMarkup(d) {
  const history = d.repaymentPlanHistory || [];
  return history.length
    ? '<details ' +
        (d.status === 'İnfaz' ? 'open ' : '') +
        'style="margin-top:20px"><summary>Önceki Yapılandırmalar (' +
        history.length +
        ')</summary>' +
        history
          .map(
            (p, i) =>
              '<div class="notice" style="margin-top:12px"><b>' +
              (i + 1) +
              '. Yapılandırma</b> · ' +
              esc(displayDate(p.createdAt)) +
              ' · ' +
              money(p.balance / 100) +
              '<div class="overflow"><table><thead><tr><th>TAKSİT</th><th>VADE</th><th>TUTAR</th></tr></thead><tbody>' +
              p.installments
                .map(
                  (r, j) =>
                    '<tr><td>' +
                    (j + 1) +
                    '</td><td>' +
                    esc(displayDate(r.due)) +
                    '</td><td>' +
                    money(r.amount / 100) +
                    '</td></tr>',
                )
                .join('') +
              '</tbody></table></div></div>',
          )
          .join('') +
        '</details>'
    : '';
}

function parkingCaptureFields(record) {
  return `<fieldset class="property-field" data-parking-capture hidden><legend>Yakalama</legend><div class="property-options">${['Var', 'Yok'].map((choice) => `<label><input type="radio" name="captureStatus" data-optional="true" value="${choice}" ${record.captureStatus === choice ? 'checked' : ''}> ${choice}</label>`).join('')}</div><div data-capture-details hidden><label class="field">Yakalama Açıklaması (isteğe bağlı)<textarea name="captureDetails" rows="3" data-optional="true" placeholder="Yakalama ile ilgili açıklamayı yazabilirsiniz…">${esc(record.captureDetails || '')}</textarea></label></div></fieldset>`;
}

function setupParkingCapture(form) {
  const box = form.querySelector('[data-parking-capture]');
  if (!box) return;
  const parking = form.elements.docType?.value === 'Yediemin Park Ücreti';
  box.hidden = !parking;
  const update = () => {
    const show = parking && form.querySelector('[name="captureStatus"]:checked')?.value === 'Var';
    box.querySelector('[data-capture-details]').hidden = !show;
    const input = form.elements.captureDetails;
    input.disabled = !show;
    input.required = false;
    input.setCustomValidity('');
  };
  box.querySelectorAll('input').forEach((r) => {
    r.disabled = !parking;
    r.required = false;
    r.onchange = update;
  });
  update();
}

function setupFinanceOperationTabs() {
  const root = document.getElementById('modal'),
    nav = document.createElement('div');
  nav.className = 'settings-tabs finance-operation-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Tahsilat ve masraf işlemleri');
  const payment = root.querySelector('#financeEntry'),
    expense = root.querySelector('#expenseEntry'),
    terms = root.querySelector('#financeTerms');
  payment.before(nav);
  function select(key) {
    financeOperationTab = key;
    payment.hidden = key !== 'payment';
    expense.hidden = key !== 'expense';
    terms.hidden = key !== 'payment';
    nav.querySelectorAll('button').forEach((b) => {
      const active = b.dataset.operation === key;
      b.classList.toggle('selected', active);
      b.setAttribute('aria-selected', String(active));
    });
  }
  for (const [key, label] of [
    ['payment', 'Tahsilat'],
    ['expense', 'Masraf'],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.operation = key;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', key === 'payment' ? 'financeEntry' : 'expenseEntry');
    b.onclick = () => select(key);
    nav.append(b);
  }
  terms.before(nav);
  select(financeOperationTab);
  root.addEventListener(
    'invalid',
    (e) => {
      if (expense.contains(e.target)) select('expense');
      else if (payment.contains(e.target) || terms.contains(e.target)) select('payment');
    },
    true,
  );
}

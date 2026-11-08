const recordListState = { key: '', cursors: [''], index: 0, next: null, request: null, timer: null };
let recordDashboardRequest;
let recordCompatibilityRequest;
async function ensureRecordWorkspace(callback) {
  if (!window.hanRecordsEnabled || window.hanWorkspaceComplete) return callback();
  if (!recordCompatibilityRequest)
    recordCompatibilityRequest = (async () => {
      await preloadServerData({ complete: true });
      db = structuredClone(hanDataBaselines.get('icrapro-v1'));
      financeEvents = structuredClone(hanDataBaselines.get('hanhukuk-finance-v1'));
      accounting = structuredClone(hanDataBaselines.get('hanhukuk-accounting-v1'));
      hanStartupData = null;
    })().finally(() => {
      recordCompatibilityRequest = null;
    });
  try {
    await recordCompatibilityRequest;
    return callback();
  } catch (error) {
    toast(error.message);
  }
}
function recordPageNeedsCompatibility() {
  return (
    window.hanRecordsEnabled &&
    !window.hanWorkspaceComplete &&
    ['accounting', 'reminders', 'messages'].includes(page)
  );
}
function renderRecordStats() {
  const summary = window.hanRecordSummary;
  if (!summary) return;
  $('#count').textContent = summary.clients;
  $('#stats').innerHTML = [
    ['Toplam müvekkil', summary.clients, 'Kayıtlı müvekkil', '◉'],
    ['Kabul Edilen Evrak', summary.documents, 'Teslim alınan toplam evrak', '▤'],
    ['Toplam Evrak Tutarı', recordMoney(summary.documentAmountCents), 'Kayıtlı evrakların toplamı', '₺'],
  ]
    .map(
      ([title, value, note, icon]) =>
        `<div class="stat"><div><small>${esc(title)}</small><strong>${esc(value)}</strong><small>${esc(note)}</small></div><span class="icon">${icon}</span></div>`,
    )
    .join('');
}
async function refreshRecordSummary() {
  if (!window.hanRecordsEnabled || window.hanWorkspaceComplete || !window.hanRecordSummary) return;
  const response = await fetch('/api/records/bootstrap', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Han-Request': '1' },
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Özet yenilenemedi.');
  window.hanRecordSummary = result.summary;
  updateActiveDebtorCount();
  if (page === 'documents') renderRecordStats();
}
function recordClientFilterMarkup() {
  const selected = db.clients.find((row) => row.id === borrowerFilters.client);
  return `<input type="search" id="recordClientLookup" data-optional="true" placeholder="Müvekkil adı veya kimlik yazın…" aria-label="Filtre için müvekkil ara"><select name="client" data-optional="true"><option value="">Tüm Müvekkiller</option>${selected ? `<option value="${esc(selected.id)}" selected>${esc(selected.name)}</option>` : ''}</select>`;
}
function bindRecordClientLookup(form) {
  const input = form.querySelector('#recordClientLookup');
  if (!input) return;
  let timer, controller;
  const search = async () => {
    controller?.abort();
    controller = new AbortController();
    try {
      const response = await fetch(
        '/api/records/search?' + new URLSearchParams({ kind: 'client', q: input.value }),
        { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' },
      );
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Müvekkiller alınamadı.');
      if (!input.isConnected) return;
      const select = form.elements.client,
        value = select.value;
      const current = [...select.options].find((o) => o.value === value);
      select.replaceChildren(new Option('Tüm Müvekkiller', ''));
      if (value && current && !result.items.some((item) => item.id === value)) select.append(current);
      for (const item of result.items) select.append(new Option(item.label, item.id));
      select.value = value;
    } catch (error) {
      if (error.name !== 'AbortError') toast(error.message);
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    controller?.abort();
    timer = setTimeout(search, 200);
  };
  input.onfocus = () => {
    if (form.elements.client.options.length < 2) search();
  };
}
async function loadRecordDashboard() {
  recordDashboardRequest?.abort();
  const request = new AbortController();
  recordDashboardRequest = request;
  const period = dashboardPeriod,
    date = dashboardDate;
  $('#content').textContent = 'Dönemin tüm tahsilat ve giderleri hesaplanıyor…';
  try {
    const response = await fetch('/api/records/dashboard?' + new URLSearchParams({ period, date }), {
      signal: request.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1' },
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Özet alınamadı.');
    if (request.signal.aborted || page !== 'home' || period !== dashboardPeriod || date !== dashboardDate)
      return;
    dashboard(
      result.buckets.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, key === 'key' ? value : BigInt(value)]),
        ),
      ),
    );
  } catch (error) {
    if (!request.signal.aborted && page === 'home') {
      $('#content').textContent = error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary';
      retry.textContent = 'Yeniden dene';
      retry.onclick = loadRecordDashboard;
      $('#content').append(retry);
    }
  }
}
function recordMoney(cents) {
  const value = BigInt(cents || '0'),
    negative = value < 0n,
    absolute = negative ? -value : value;
  return (
    (negative ? '-' : '') +
    (absolute / 100n).toLocaleString('tr-TR') +
    ',' +
    String(absolute % 100n).padStart(2, '0') +
    ' TL'
  );
}
function recordListInput() {
  if (debtorStatusFilter !== 'İnfaz') {
    delete debtorColumnFilters.closure;
    const closure = document.querySelector('[data-debtor-column=closure]');
    if (closure) closure.value = '';
  }
  const input = {
    ...borrowerFilters,
    status: debtorStatusFilter,
    query: $('#docSearch')?.value || '',
    limit: '50',
    sort:
      debtorEntryDateSort === 1 ? 'trackingAsc' : debtorEntryDateSort === -1 ? 'trackingDesc' : 'entryOrder',
  };
  for (const [key, value] of Object.entries(debtorColumnFilters))
    input['column' + key[0].toUpperCase() + key.slice(1)] = value;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== '' && value != null)
      .map(([key, value]) => [key, String(value)]),
  );
}
function queueRecordPage() {
  clearTimeout(recordListState.timer);
  recordListState.request?.abort();
  recordListState.timer = setTimeout(() => loadRecordPage(), 150);
}
async function loadRecordPage(direction = 0) {
  const input = recordListInput(),
    key = JSON.stringify(input),
    state = recordListState;
  if (state.key !== key) {
    state.key = key;
    state.index = 0;
    state.cursors = [''];
    state.next = null;
  }
  const target = direction < 0 ? Math.max(0, state.index - 1) : direction > 0 ? state.index + 1 : state.index;
  if (direction > 0 && !state.next) return;
  const cursor = direction > 0 ? state.next : state.cursors[target];
  if (cursor) input.after = cursor;
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  const footer = $('#docSearchCount');
  if (!footer) return;
  footer.textContent = 'Kayıtlar ve tüm filtreli toplamlar yükleniyor…';
  $('#docRows').closest('table').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/records/documents?' + new URLSearchParams(input), {
      signal: request.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1' },
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Liste yüklenemedi.');
    if (request.signal.aborted || page !== 'documents' || !$('#docRows')) return;
    state.index = target;
    state.cursors[target] = cursor || '';
    state.next = result.next;
    const showClosureDate = debtorStatusFilter === 'İnfaz';
    $('#closureDateHeading').hidden = !showClosureDate;
    $('#debtorColumnStatus').value = debtorStatusFilter;
    $('#clearDocSearch').hidden = !input.query;
    $('#debtorEntryDateHeading').setAttribute(
      'aria-sort',
      debtorEntryDateSort === 1 ? 'ascending' : debtorEntryDateSort === -1 ? 'descending' : 'none',
    );
    $('#sortDebtorEntryDate').textContent =
      'TAKİP TARİHİ ' + (debtorEntryDateSort === 1 ? '↑' : debtorEntryDateSort === -1 ? '↓' : '↕');
    document.querySelectorAll('[data-status-filter]').forEach((button) => {
      const status = button.dataset.statusFilter;
      const count =
        status === 'Tümü'
          ? Object.values(result.statusCounts).reduce((n, v) => n + BigInt(v), 0n)
          : BigInt(result.statusCounts[status] || '0');
      button.textContent = status + ' (' + count.toLocaleString('tr-TR') + ')';
      button.classList.toggle('selected', status === debtorStatusFilter);
      button.setAttribute('aria-pressed', String(status === debtorStatusFilter));
    });
    const rows = result.items.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      docType: row.kind,
      client: row.clientId,
      _clientName: row.clientName,
      debtor: row.debtor,
      identity: row.identity,
      relatedStaff: row.staffId,
      relatedStaffName: row.staffName || row.relatedStaffName,
      amount: Number(row.principalCents) / 100,
      due: row.due,
      trackingDate: row.trackingDate,
      closedDate: row.closedDate,
      _principalCents: row.principalCents,
      _targetCents: row.targetCents,
      _listFinance: {
        principal: Number(row.principalCents),
        target: Number(row.targetCents),
        received: Number(row.receivedCents),
        remaining: Number(row.remainingCents),
      },
    }));
    paintDocumentRows(rows, ['ceo', 'admin'].includes(hanAuth.role), showClosureDate);
    const first = rows.length ? target * 50 + 1 : 0,
      last = rows.length ? target * 50 + rows.length : 0;
    footer.replaceChildren();
    const summary = document.createElement('div');
    summary.textContent = `${first}–${last} / ${BigInt(result.totals.count).toLocaleString('tr-TR')} kayıt · Tüm filtreli kayıtların toplam alacağı: ${recordMoney(result.totals.targetCents)} · Tahsil edilen: ${recordMoney(result.totals.receivedCents)} · Kalan: ${recordMoney(result.totals.remainingCents)}`;
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    for (const [label, step, disabled] of [
      ['Önceki sayfa', -1, target === 0],
      ['Sonraki sayfa', 1, !result.next],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.disabled = disabled;
      button.onclick = () => loadRecordPage(step);
      actions.append(button);
    }
    footer.append(summary, actions);
    refreshRecordSummary().catch(() => {});
  } catch (error) {
    if (!request.signal.aborted && $('#docSearchCount') === footer) {
      $('#docRows').replaceChildren();
      footer.textContent = error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary';
      retry.textContent = 'Yeniden dene';
      retry.onclick = () => loadRecordPage();
      footer.append(retry);
    }
  } finally {
    if (state.request === request) $('#docRows')?.closest('table').removeAttribute('aria-busy');
  }
}
async function recordAction(id, callback) {
  if (!window.hanRecordsEnabled) return callback();
  try {
    const response = await fetch('/api/records/document?id=' + encodeURIComponent(id) + '&section=context', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1' },
    });
    const context = await response.json();
    if (!response.ok) throw Error(context.error || 'Dosya yüklenemedi.');
    if (context.accountBalances) window.hanAccountBalances = context.accountBalances;
    // Separate responses keep two valid 3 MB files below the platform's
    // per-response limit. Publish no partial edit context if a fetch fails.
    await Promise.all(
      (context.attachments || []).map(async (attachment) => {
        const response = await fetch(
          '/api/records/document?' +
            new URLSearchParams({ id, section: 'attachment', attachmentId: attachment.id }),
          { credentials: 'same-origin', cache: 'no-store' },
        );
        const result = await response.json();
        if (!response.ok || !['fileData', 'photoData'].includes(result.field))
          throw Error(result.error || 'Dosya eki yüklenemedi.');
        context.record[result.field] = result.value;
      }),
    );
    const replace = (rows, values, predicate) => {
      const fresh = new Map(values.map((value) => [value.id, value]));
      const result = rows.flatMap((row) => {
        if (!predicate(row)) return [row];
        const value = fresh.get(row.id);
        fresh.delete(row.id);
        return value ? [value] : [];
      });
      return [...result, ...fresh.values()];
    };
    const update = (key, value) => {
      const baseline = hanDataBaselines.get(key);
      if (key === 'icrapro-v1') {
        for (const target of [db, baseline].filter(Boolean)) {
          target.docs = replace(target.docs, [structuredClone(context.record)], (row) => row.id === id);
          if (context.client)
            target.clients = replace(
              target.clients,
              [structuredClone(context.client)],
              (row) => row.id === context.client.id,
            );
        }
      } else if (key === 'hanhukuk-finance-v1') {
        financeEvents = replace(financeEvents, value, (row) => row.documentId === id);
        if (baseline)
          hanDataBaselines.set(
            key,
            replace(baseline, structuredClone(value), (row) => row.documentId === id),
          );
      } else {
        accounting.entries = replace(accounting.entries, value, (row) => row.documentId === id);
        if (baseline)
          baseline.entries = replace(
            baseline.entries,
            structuredClone(value),
            (row) => row.documentId === id,
          );
      }
    };
    update('icrapro-v1');
    update('hanhukuk-finance-v1', context.financialEvents);
    update('hanhukuk-accounting-v1', context.ledgerEntries);
    return callback();
  } catch (error) {
    toast(error.message);
  }
}

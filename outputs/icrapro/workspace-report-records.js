const recordReportState = { key: '', cursors: [''], index: 0, request: null, timer: null };
const reportClientCache = new Map();
let recordInsRequest;
let recordPayrollRequest;
let recordReportScreen = 'reports';
async function recordReportFetch(url, signal) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'X-Han-Request': '1' },
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Rapor alınamadı.');
  return data;
}
function recordReportClients() {
  if (!reportFilters.client) return [];
  const current =
    reportClientCache.get(reportFilters.client) || db.clients.find((c) => c.id === reportFilters.client);
  return current ? [current] : [];
}
function bindReportClientLookup() {
  const select = $('#reportClient');
  if (!select) return;
  select.setAttribute('aria-label', 'Rapor müvekkili');
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'reportClientLookup';
  input.placeholder = 'Müvekkil adı veya kimlik ara…';
  input.setAttribute('aria-label', 'Rapor için müvekkil ara');
  input.dataset.optional = 'true';
  select.before(input);
  const hint = document.createElement('small');
  select.after(hint);
  let timer, controller;
  const search = async () => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    try {
      const result = await recordReportFetch(
        '/api/records/search?' + new URLSearchParams({ kind: 'client', q: input.value }),
        request.signal,
      );
      if (!input.isConnected || controller !== request) return;
      const selected = select.value,
        current = [...select.options].find((o) => o.value === selected);
      select.replaceChildren(new Option('Tümü', ''));
      if (selected && current && !result.items.some((c) => c.id === selected)) select.append(current);
      for (const row of result.items) {
        reportClientCache.set(row.id, { id: row.id, name: row.name || row.label });
        select.append(new Option(row.name || row.label, row.id));
      }
      select.value = selected;
      hint.textContent = result.more ? 'İlk 50 eşleşme gösteriliyor; aramayı daraltabilirsiniz.' : '';
    } catch (error) {
      if (error.name !== 'AbortError' && input.isConnected) hint.textContent = error.message;
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    controller?.abort();
    timer = setTimeout(search, 200);
  };
  input.onfocus = search;
  const query = $('#reportQuery'),
    refresh = query.oninput;
  query.oninput = () => {
    clearTimeout(recordReportState.timer);
    recordReportState.request?.abort();
    recordReportState.timer = setTimeout(refresh, 200);
  };
}
async function loadRecordReport() {
  const result = $('#reportResult');
  if (!result) return;
  const key = JSON.stringify(reportFilters),
    state = recordReportState;
  if (key !== state.key) {
    state.key = key;
    state.cursors = [''];
    state.index = 0;
  }
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  result.textContent = 'Rapor hazırlanıyor…';
  result.setAttribute('aria-busy', 'true');
  for (const id of ['printReport', 'exportReport']) if ($('#' + id)) $('#' + id).disabled = true;
  try {
    const data = await recordReportFetch(
      '/api/records/reports?' +
        new URLSearchParams({ ...reportFilters, limit: 50, after: state.cursors[state.index] }),
      request.signal,
    );
    if (!result.isConnected || request !== state.request) return;
    const def = reportDefinitions[reportFilters.type],
      first = Number(data.count) ? state.index * 50 + 1 : 0,
      last = state.index * 50 + data.items.length;
    const openable =
      reportFilters.type === 'excel'
        ? new Set(data.items.map((r) => r.documentId).filter(Boolean))
        : undefined;
    result.innerHTML = `<div class="notice">${esc(data.count)} kayıt · Tarihsiz: ${esc(data.undated)}. Toplamlar filtreye uyan tüm kayıtları kapsar. CSV ve yazdırma tüm sonuçları içerir.</div><div class="panel"><div class="panelhead"><h2>${esc(def.label)}</h2></div>${reportTable(def, data.items, openable, data.totals)}<div class="tablefoot"><span>${first}–${last} / ${esc(data.count)} kayıt</span><div class="toolbar"><button class="secondary" id="previousReport" ${state.index ? '' : 'disabled'}>Önceki</button><button class="secondary" id="nextReport" ${data.next ? '' : 'disabled'}>Sonraki</button></div></div></div>`;
    $('#previousReport').onclick = () => {
      if (state.index) {
        state.index--;
        loadRecordReport();
      }
    };
    $('#nextReport').onclick = () => {
      if (data.next) {
        state.cursors[++state.index] = data.next;
        loadRecordReport();
      }
    };
    result.querySelectorAll('[data-report-borrower]').forEach((button) => {
      button.onclick = () =>
        recordAction(button.dataset.reportBorrower, () => borrowerDetail(button.dataset.reportBorrower));
    });
    for (const id of ['printReport', 'exportReport']) if ($('#' + id)) $('#' + id).disabled = false;
  } catch (error) {
    if (error.name !== 'AbortError' && result.isConnected && request === state.request)
      result.textContent = error.message;
  } finally {
    if (result.isConnected && request === state.request) result.removeAttribute('aria-busy');
  }
}
async function exportRecordReport(format) {
  if (reportFilters.from && reportFilters.to && reportFilters.from > reportFilters.to)
    return toast('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  const url = '/api/records/reports/export?' + new URLSearchParams({ ...reportFilters, format });
  if (format === 'csv') {
    const button = $('#exportReport'),
      type = reportFilters.type;
    if (button) button.disabled = true;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw Error((await response.json()).error || 'Rapor indirilemedi.');
      const href = URL.createObjectURL(await response.blob()),
        link = document.createElement('a');
      link.href = href;
      link.download = 'hanhukuk-' + type + '-' + businessDate() + '.csv';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      toast(error.message);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
    return;
  }
  const frame = document.createElement('iframe');
  frame.title = 'Rapor yazdırma';
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
  frame.onload = () => {
    try {
      const body = frame.contentDocument?.body;
      if (!body?.querySelector('table')) {
        toast(body?.textContent || 'Rapor oluşturulamadı.');
        frame.remove();
        return;
      }
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60000);
    } catch (error) {
      frame.remove();
      toast(error.message);
    }
  };
  frame.src = url;
  document.body.append(frame);
}
async function loadRecordInsReport() {
  recordReportScreen = 'ins';
  recordReportState.request?.abort();
  recordPayrollRequest?.abort();
  insDate = insDate || businessDate();
  insEndDate = insEndDate || insDate;
  recordInsRequest?.abort();
  const request = new AbortController();
  recordInsRequest = request;
  const content = $('#content');
  content.textContent = 'İNS raporu hazırlanıyor…';
  try {
    const data = await recordReportFetch(
      '/api/records/reports/ins?' + new URLSearchParams({ from: insDate, to: insEndDate }),
      request.signal,
    );
    if (request !== recordInsRequest || page !== 'reports' || recordReportScreen !== 'ins') return;
    const rows = data.rows.map((r) => {
      const row = { ...r };
      for (const key of ['collected', 'closedCount', 'closedAmount']) {
        row[key] = Number(r[key]);
        if (!Number.isSafeInteger(row[key])) throw Error('Rapor tutarı güvenli gösterim sınırını aşıyor.');
      }
      return row;
    });
    for (const key of ['collected', 'closedCount', 'closedAmount'])
      if (!Number.isSafeInteger(rows.reduce((s, r) => s + r[key], 0)))
        throw Error('Rapor toplamı güvenli gösterim sınırını aşıyor.');
    renderInsReportPage(rows);
  } catch (error) {
    if (
      error.name !== 'AbortError' &&
      request === recordInsRequest &&
      page === 'reports' &&
      recordReportScreen === 'ins'
    ) {
      content.textContent = error.message;
      const back = document.createElement('button');
      back.className = 'secondary';
      back.textContent = 'Raporlara Dön';
      back.onclick = reportsPage;
      content.append(back);
    }
  }
}

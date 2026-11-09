const recordClientList = { q: '', cursors: [''], index: 0, request: null, timer: null };
let recordClientOpening = 0;

function renderRecordClientStats(summary) {
  const target = $('#stats');
  if (!['ceo', 'admin'].includes(hanAuth.role)) return;
  if (!summary) {
    target.textContent = 'Tüm müvekkil ve evrakların özeti yükleniyor…';
    return;
  }
  $('#count').textContent = summary.clients;
  const cards = [
    ['Toplam müvekkil', summary.clients, 'Kayıtlı tüm müvekkiller', '◉'],
    ['Kabul Edilen Evrak', summary.documents, 'Teslim alınan toplam evrak', '▤'],
    ['Toplam Tutar', recordMoney(summary.amountCents), 'Kayıtlı tüm evrakların toplam tutarı', '₺'],
    ['İnfaz Edilen Evrak', summary.closed, 'İnfaz durumundaki tüm evraklar', '✓'],
    ['İade Edilen Evrak', summary.returned, 'İade durumundaki tüm evraklar', '↩'],
    ['İnfaz Edilen Tutar', recordMoney(summary.closedCents), 'İnfaz edilen tüm evrakların tutarı', '₺'],
    ['Müvekkile Ödenen Tutar', recordMoney(summary.paidCents), 'Kaydedilmiş tüm müvekkil ödemeleri', '₺'],
  ];
  target.innerHTML = cards
    .map(
      ([title, value, note, icon]) =>
        `<div class="stat"><div><small>${esc(title)}</small><strong>${esc(value)}</strong><small>${esc(note)}</small></div><span class="icon">${icon}</span></div>`,
    )
    .join('');
}

function scheduleRecordClientPage() {
  const q = $('#search')?.value.trim() || '';
  if (q !== recordClientList.q) {
    recordClientList.q = q;
    recordClientList.cursors = [''];
    recordClientList.index = 0;
  }
  clearTimeout(recordClientList.timer);
  recordClientList.request?.abort();
  recordClientList.timer = setTimeout(() => loadRecordClientPage(), 200);
}

async function loadRecordClientPage() {
  clearTimeout(recordClientList.timer);
  recordClientList.request?.abort();
  const request = new AbortController();
  recordClientList.request = request;
  const rows = $('#rows'),
    footer = $('#total'),
    input = $('#search');
  if (page !== 'clients' || !rows || !input) return;
  const q = input.value.trim();
  if (q !== recordClientList.q) {
    recordClientList.q = q;
    recordClientList.cursors = [''];
    recordClientList.index = 0;
  }
  rows.innerHTML = '<tr><td colspan="5" class="empty">Müvekkiller yükleniyor…</td></tr>';
  footer.textContent = '';
  $('#clientSuggestions').hidden = true;
  input.setAttribute('aria-expanded', 'false');
  try {
    const params = new URLSearchParams({ q, limit: '50' });
    const cursor = recordClientList.cursors[recordClientList.index];
    if (cursor) params.set('after', cursor);
    const response = await fetch('/api/records/clients?' + params, {
      signal: request.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Müvekkiller alınamadı.');
    if (request.signal.aborted || !rows.isConnected || page !== 'clients' || input.value.trim() !== q) return;
    paintClientRows(result.items, true);
    renderClientSuggestions(q, result.items);
    // Search/list limits do not affect these workspace-wide totals.
    if (result.summary) {
      renderRecordClientStats(result.summary);
      if (window.hanRecordSummary) window.hanRecordSummary.clients = result.summary.clients;
    }
    const start = result.items.length ? recordClientList.index * 50 + 1 : 0;
    footer.innerHTML = `<span>${start}–${result.items.length ? start + result.items.length - 1 : 0} / ${esc(result.count)} müvekkil${q ? ' · Arama sonucu' : ''}</span><div><button type="button" class="secondary" id="previousClients" ${recordClientList.index ? '' : 'disabled'}>Önceki</button> <button type="button" class="secondary" id="nextClients" ${result.next ? '' : 'disabled'}>Sonraki</button></div>`;
    $('#previousClients').onclick = () => {
      recordClientList.index--;
      loadRecordClientPage();
    };
    $('#nextClients').onclick = () => {
      recordClientList.cursors[++recordClientList.index] = result.next;
      loadRecordClientPage();
    };
  } catch (error) {
    if (request.signal.aborted || !rows.isConnected || page !== 'clients') return;
    rows.innerHTML = `<tr><td colspan="5" class="empty">${esc(error.message)}</td></tr>`;
    footer.innerHTML = '<button type="button" class="secondary" id="retryClients">Yeniden dene</button>';
    $('#retryClients').onclick = loadRecordClientPage;
  }
}

async function openRecordClient(id) {
  const opening = ++recordClientOpening;
  try {
    const read = async (params) => {
      const response = await fetch('/api/records/client?' + new URLSearchParams({ id, ...params }), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || 'Müvekkil açılamadı.');
      return value;
    };
    const result = await read({});
    const record = structuredClone(result.record);
    // Read only this client's attachments, separately to keep each response bounded.
    if (result.attachments?.length) {
      record.attachments = [];
      for (const attachment of result.attachments) {
        if (opening !== recordClientOpening) return;
        const value = await read({
          section: 'attachment',
          attachmentId: attachment.id,
          revision: attachment.revision,
        });
        record.attachments.push(value.value);
      }
    }
    if (opening === recordClientOpening) clientModal(id, record);
  } catch (error) {
    if (opening === recordClientOpening) toast(error.message);
  }
}

async function saveRecordClient(before, next) {
  const patch = HanRecordPatch.diff(
    'icrapro-v1',
    { clients: before ? [before] : [], docs: [] },
    { clients: [next], docs: [] },
  );
  if (!patch) throw Error('Müvekkil değişikliği hazırlanamadı.');
  if (!patch.changes.length) return;
  const response = await fetch('/api/data/patch?key=icrapro-v1', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    body: JSON.stringify(patch),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Müvekkil kaydedilemedi.');
  const saved = result.records?.find((r) => r.path?.[0] === 'clients' && r.id === next.id);
  if (!saved?.value) throw Error('Kaydedilen müvekkil yanıtı alınamadı. Sayfayı yenileyin.');
  const value = structuredClone(saved.value);
  for (const field of saved.preservedFields || []) value[field] = structuredClone(next[field]);
  const merge = (rows) => {
    const index = rows.findIndex((row) => row.id === next.id);
    if (index < 0) rows.push(structuredClone(value));
    else rows[index] = structuredClone(value);
  };
  // Publish only after success: a rejected/stale save cannot alter local records.
  merge(db.clients);
  const baseline = hanDataBaselines.get('icrapro-v1');
  if (baseline) merge(baseline.clients);
}
function setupClientStatement(form, clientId, clientName = '') {
  const panel = form.querySelector('[data-form-panel="financial"] .grid');
  if (!panel) return;
  const host = document.createElement('div');
  host.className = 'full';
  host.innerHTML =
    '<h3>Hesap Ekstresi · Müvekkile Yapılan Ödemeler</h3><div class="grid"><label class="field">Başlangıç Tarihi<input type="date" data-statement-start data-optional="true"></label><label class="field">Bitiş Tarihi<input type="date" data-statement-end data-optional="true"></label></div><div class="toolbar"><button type="button" class="secondary" data-statement-filter>Filtrele</button><button type="button" class="secondary" data-statement-clear>Tümünü Göster</button></div><p data-statement-total role="status"></p><div class="overflow" style="max-height:48vh;overflow:auto"><table><thead><tr><th>TARİH</th><th>FÖY NO</th><th>BORÇLU ADI</th><th>ÖDENEN TUTAR</th><th>GÖNDEREN BANKA / KASA</th><th>AÇIKLAMA</th></tr></thead><tbody data-statement-rows></tbody></table></div><div class="tablefoot"><span data-statement-page></span><div class="toolbar"><button type="button" class="secondary" data-statement-prev>Önceki</button><button type="button" class="secondary" data-statement-next>Sonraki</button></div></div><small>Tarihi veya banka bilgisi olmayan eski toplu ödemeler ayrıca belirtilir; tarih filtresinde yer almaz.</small>';
  panel.append(host);
  if (clientName) host.querySelector('h3').textContent = clientName + ' · Hesap Ekstresi';
  let offset = 0,
    start = '',
    end = '',
    request,
    opened = false;
  const total = host.querySelector('[data-statement-total]');
  const rows = host.querySelector('[data-statement-rows]');
  const previous = host.querySelector('[data-statement-prev]');
  const next = host.querySelector('[data-statement-next]');
  async function load() {
    request?.abort();
    const current = new AbortController();
    request = current;
    total.textContent = 'Ödemeler yükleniyor…';
    rows.replaceChildren();
    previous.disabled = next.disabled = true;
    try {
      let data;
      if (window.hanRecordsEnabled) {
        const response = await fetch(
          '/api/records/client?' +
            new URLSearchParams({ id: clientId, section: 'statement', start, end, offset }),
          { credentials: 'same-origin', cache: 'no-store', signal: current.signal },
        );
        data = await response.json();
        if (!response.ok) throw Error(data.error || 'Hesap ekstresi alınamadı.');
      } else {
        const docs = new Map(db.docs.filter((d) => d.client === clientId).map((d) => [d.id, d]));
        let items = accounting.entries
          .filter(
            (e) =>
              e.type === 'clientPayout' && (e.clientId ? e.clientId === clientId : docs.has(e.documentId)),
          )
          .map((e) => ({
            id: e.id,
            date: e.date || '',
            number: docs.get(e.documentId)?.number || '—',
            debtor: docs.get(e.documentId)?.debtor || '—',
            amount: String(e.amount),
            bank:
              e.accountName || accounting.accounts.find((a) => a.id === e.accountId)?.name || 'Belirtilmedi',
            note: e.note || '',
          }));
        for (const d of docs.values())
          if (Number(d.clientPaidAmount) > 0)
            items.push({
              id: 'legacy:' + d.id,
              date: '',
              number: d.number,
              debtor: d.debtor,
              amount: String(financeCents(d.clientPaidAmount)),
              bank: 'Belirtilmedi',
              note: 'Eski kayıttaki toplam ödeme · Tarih ve banka bilgisi bulunmuyor.',
            });
        items = items
          .filter((e) => (!start || e.date >= start) && (!end || (e.date && e.date <= end)))
          .sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
        data = {
          items: items.slice(offset, offset + 50),
          totals: {
            count: String(items.length),
            paid: String(items.reduce((s, e) => s + BigInt(e.amount), 0n)),
          },
          more: offset + 50 < items.length,
        };
      }
      if (!host.isConnected || request !== current || current.signal.aborted) return;
      if (!data.items.length && offset > 0) {
        offset = 0;
        return load();
      }
      total.textContent = data.totals.count + ' ödeme · Toplam ödenen: ' + recordMoney(data.totals.paid);
      rows.innerHTML =
        data.items
          .map(
            (e) =>
              `<tr><td>${esc(e.date ? displayDate(e.date) : 'Tarih yok')}</td><td>${esc(e.number)}</td><td>${esc(e.debtor)}</td><td style="white-space:nowrap"><strong>${esc(recordMoney(e.amount))}</strong></td><td>${esc(e.bank)}</td><td>${esc(e.note)}</td></tr>`,
          )
          .join('') || '<tr><td colspan="6" class="empty">Bu müvekkile yapılmış ödeme bulunamadı.</td></tr>';
      host.querySelector('[data-statement-page]').textContent =
        `${data.items.length ? offset + 1 : 0}–${offset + data.items.length} / ${data.totals.count}`;
      previous.disabled = offset === 0;
      next.disabled = !data.more;
    } catch (error) {
      if (!current.signal.aborted && host.isConnected) total.textContent = error.message;
    }
  }
  previous.onclick = () => {
    offset = Math.max(0, offset - 50);
    load();
  };
  next.onclick = () => {
    offset += 50;
    load();
  };
  host.querySelector('[data-statement-filter]').onclick = () => {
    const from = host.querySelector('[data-statement-start]').value,
      to = host.querySelector('[data-statement-end]').value;
    if (from && to && from > to) {
      total.textContent = 'Başlangıç tarihi bitiş tarihinden sonra olamaz.';
      return;
    }
    start = from;
    end = to;
    offset = 0;
    load();
  };
  host.querySelector('[data-statement-clear]').onclick = () => {
    host.querySelectorAll('input').forEach((i) => {
      i.value = '';
      if (i._dateProxy) i._dateProxy.value = '';
    });
    start = end = '';
    offset = 0;
    load();
  };
  form.addEventListener('record-form-tab', (event) => {
    if (event.detail.key === 'financial' && !opened) {
      opened = true;
      load();
    }
  });
}

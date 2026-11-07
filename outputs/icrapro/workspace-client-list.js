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
    if (request.signal.aborted || !rows.isConnected || page !== 'clients') return;
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

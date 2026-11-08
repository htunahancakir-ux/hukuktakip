const recordIntakeList = { query: '', cursors: [''], index: 0, request: null, timer: null };
let recordIntakeSummaryRequest;
// Search and receipt projections must never become editable workspace records.
const recordIntakeClients = new Map(),
  recordIntakeBatchDocs = new Map();
function mergeIntakeClient(client) {
  if (!client?.id) return;
  recordIntakeClients.set(client.id, client);
}
function intakeClient(id) {
  return recordIntakeClients.get(id) || db.clients.find((c) => c.id === id);
}
function intakeBatchDocument(id) {
  return recordIntakeBatchDocs.get(id) || db.docs.find((d) => d.id === id);
}
async function readIntakeJson(path, signal) {
  const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Evrak bilgileri alınamadı.');
  return result;
}
async function ensureIntakeClient(id) {
  if (!id) return null;
  const result = await readIntakeJson('/api/records/search?' + new URLSearchParams({ kind: 'client', id }));
  const item = result.items.find((c) => c.id === id);
  if (!item) throw Error('Müvekkil bulunamadı.');
  const client = { id: item.id, name: item.name || item.label, identity: item.identity };
  mergeIntakeClient(client);
  return client;
}
function bindIntakeClientSelect(input, select, emptyLabel, result) {
  let timer, controller;
  const search = async () => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    try {
      const response = await readIntakeJson(
        '/api/records/search?' + new URLSearchParams({ kind: 'client', q: input.value }),
        request.signal,
      );
      if (request.signal.aborted || !select.isConnected) return;
      const value = select.value,
        current = [...select.options].find((o) => o.value === value);
      select.replaceChildren(new Option(emptyLabel, ''));
      if (value && current && !response.items.some((item) => item.id === value)) select.append(current);
      for (const item of response.items) {
        mergeIntakeClient({ id: item.id, name: item.name || item.label, identity: item.identity });
        select.append(new Option(item.name || item.label, item.id));
      }
      select.value = value;
      if (result)
        result.textContent = response.more
          ? 'İlk 50 eşleşme gösteriliyor; aramayı daraltabilirsiniz.'
          : response.items.length + ' eşleşme';
    } catch (error) {
      if (!request.signal.aborted && input.isConnected) toast(error.message);
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    controller?.abort();
    timer = setTimeout(search, 200);
  };
  input.onfocus = () => {
    if (select.options.length < 2) search();
  };
  select.onfocus = () => {
    if (select.options.length < 2) search();
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      select.focus();
    }
  };
  search();
}
function setIntakeClientOption(select, id) {
  if (!select) return;
  const client = intakeClient(id);
  if (client && ![...select.options].some((o) => o.value === id)) select.append(new Option(client.name, id));
  select.value = id;
}
function renderRecordIntakeScope(bar, filter) {
  bar.hidden = false;
  let input = document.getElementById('intakeScopeSearch');
  if (!input) {
    input = document.createElement('input');
    input.id = 'intakeScopeSearch';
    input.type = 'search';
    input.placeholder = 'Müvekkil adı veya kimlik ara…';
    input.setAttribute('aria-label', 'Özet için müvekkil ara');
    input.dataset.optional = 'true';
    filter.before(input);
  }
  filter.innerHTML = '<option value="">Tüm Müvekkiller</option>';
  setIntakeClientOption(filter, selected);
  bindIntakeClientSelect(input, filter, 'Tüm Müvekkiller');
  filter.onchange = () => {
    selected = filter.value;
    setIntakeClientOption(document.getElementById('intakeForm')?.elements.client, selected);
    stats();
  };
  if (selected && !intakeClient(selected)) {
    const id = selected;
    ensureIntakeClient(id)
      .then(() => {
        if (selected === id && filter.isConnected) {
          setIntakeClientOption(filter, id);
          setIntakeClientOption(document.getElementById('intakeForm')?.elements.client, id);
          stats();
        }
      })
      .catch((error) => toast(error.message));
  }
}
async function renderRecordIntakeStats() {
  recordIntakeSummaryRequest?.abort();
  const request = new AbortController();
  recordIntakeSummaryRequest = request;
  const id = selected;
  const target = $('#stats');
  target.textContent = 'Evrakların tamamı üzerinden özet hesaplanıyor…';
  try {
    const result = await readIntakeJson(
      '/api/records/documents?' + new URLSearchParams({ client: id || '', status: 'Tümü', limit: '1' }),
      request.signal,
    );
    if (request.signal.aborted || page !== 'intake' || selected !== id) return;
    const cards = [
      [
        id ? 'Seçili müvekkil' : 'Toplam müvekkil',
        id ? '1' : window.hanRecordSummary?.clients || '0',
        id ? intakeClient(id)?.name || 'Seçili müvekkil' : 'Kayıtlı müvekkiller',
      ],
      ['Kabul Edilen Evrak', result.totals.count, 'Seçime uyan tüm evraklar'],
      [
        'Toplam Evrak Tutarı',
        recordMoney(result.totals.principalCents),
        'Seçime uyan tüm evrakların toplamı',
      ],
    ];
    target.innerHTML = cards
      .map(
        ([title, value, note]) =>
          `<div class="stat"><div><small>${esc(title)}</small><strong>${esc(value)}</strong><small>${esc(note)}</small></div></div>`,
      )
      .join('');
  } catch (error) {
    if (!request.signal.aborted && page === 'intake') target.textContent = error.message;
  }
}
function bindRecordIntakeSearch() {
  const input = $('#intakeSearch');
  if (!input) return;
  input.value = recordIntakeList.query;
  input.oninput = () => {
    clearTimeout(recordIntakeList.timer);
    recordIntakeList.request?.abort();
    recordIntakeList.timer = setTimeout(loadRecordIntakePage, 200);
  };
  loadRecordIntakePage();
}
async function loadRecordIntakePage() {
  clearTimeout(recordIntakeList.timer);
  recordIntakeList.request?.abort();
  const request = new AbortController();
  recordIntakeList.request = request;
  const input = $('#intakeSearch'),
    rows = $('#intakeSearchResults'),
    footer = $('#intakeSearchTotal');
  if (!input || page !== 'intake') return;
  const query = input.value.trim();
  if (recordIntakeList.query !== query) {
    recordIntakeList.query = query;
    recordIntakeList.index = 0;
    recordIntakeList.cursors = [''];
  }
  rows.innerHTML = '<tr><td colspan="4" class="empty">Evraklar yükleniyor…</td></tr>';
  footer.textContent = '';
  try {
    const params = new URLSearchParams({
      query,
      status: 'Tümü',
      sort: 'entryOrder',
      limit: '50',
      after: recordIntakeList.cursors[recordIntakeList.index],
    });
    const result = await readIntakeJson('/api/records/documents?' + params, request.signal);
    if (request.signal.aborted || !rows.isConnected || page !== 'intake') return;
    rows.innerHTML =
      result.items
        .map(
          (d) =>
            `<tr><td><strong>${esc(d.number)}</strong><small>${esc(d.kind)}</small></td><td>${esc(d.debtor)}<small>${esc(d.clientName)}</small></td><td>${esc(d.status)}</td><td><button type="button" class="link" data-edit-intake="${esc(d.id)}">Aç / Düzelt</button></td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="empty">Eşleşen evrak bulunamadı.</td></tr>';
    const start = result.items.length ? recordIntakeList.index * 50 + 1 : 0;
    footer.innerHTML = `<span>${start}–${result.items.length ? start + result.items.length - 1 : 0} / ${esc(result.totals.count)} evrak</span><div><button type="button" class="secondary" id="previousIntake" ${recordIntakeList.index ? '' : 'disabled'}>Önceki</button> <button type="button" class="secondary" id="nextIntake" ${result.next ? '' : 'disabled'}>Sonraki</button></div>`;
    rows.querySelectorAll('[data-edit-intake]').forEach((button) => {
      button.onclick = () => intake(button.dataset.editIntake);
    });
    $('#previousIntake').onclick = () => {
      recordIntakeList.index--;
      loadRecordIntakePage();
    };
    $('#nextIntake').onclick = () => {
      recordIntakeList.cursors[++recordIntakeList.index] = result.next;
      loadRecordIntakePage();
    };
  } catch (error) {
    if (request.signal.aborted || !rows.isConnected) return;
    rows.innerHTML = `<tr><td colspan="4" class="empty">${esc(error.message)}</td></tr>`;
    footer.innerHTML = '<button type="button" id="retryIntake" class="secondary">Yeniden dene</button>';
    $('#retryIntake').onclick = loadRecordIntakePage;
  }
}
async function saveRecordIntake(original, next) {
  const patch = HanRecordPatch.diff(
    'icrapro-v1',
    { clients: [], docs: original ? [original] : [] },
    { clients: [], docs: [next] },
  );
  if (!patch) throw Error('Evrak değişikliği hazırlanamadı.');
  if (!patch.changes.length) return original;
  const response = await fetch('/api/data/patch?key=icrapro-v1&operation=intake', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    body: JSON.stringify(patch),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Evrak kaydedilemedi.');
  const saved = result.records?.find((row) => row.id === next.id && row.path?.[0] === 'docs');
  if (!saved?.value) throw Error('Kaydedilen evrak yanıtı alınamadı. Sayfayı yenileyin.');
  const doc = structuredClone(saved.value);
  for (const field of saved.preservedFields || [])
    if (Object.hasOwn(next, field)) doc[field] = structuredClone(next[field]);
  const merge = (value) => {
    const i = value.docs.findIndex((row) => row.id === doc.id);
    if (i < 0) value.docs.push(structuredClone(doc));
    else value.docs[i] = structuredClone(doc);
  };
  merge(db);
  const baseline = hanDataBaselines.get('icrapro-v1');
  if (baseline) merge(baseline);
  return doc;
}
async function hydrateIntakeBatch() {
  const ids = intakeBatchIds();
  const valid = new Set();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const result = await readIntakeJson(
      '/api/records/intake-batch?' +
        new URLSearchParams({ ids: JSON.stringify(ids.slice(offset, offset + 100)) }),
    );
    for (const item of result.items) {
      valid.add(item.record.id);
      mergeIntakeClient(item.client);
      recordIntakeBatchDocs.set(item.record.id, item.record);
    }
  }
  // Do not erase a document added by a nested form while the request was in flight.
  sessionStorage.setItem(
    intakeBatchKey(),
    JSON.stringify(intakeBatchIds().filter((id) => !ids.includes(id) || valid.has(id))),
  );
}
async function refreshRecordIntakeBatch() {
  try {
    await hydrateIntakeBatch();
    const group = $('#intakeBatchGroup');
    if (group) {
      group.outerHTML = intakeBatchToolbar();
      bindIntakeBatchToolbar();
    }
    if (page === 'intake' && ['ceo', 'admin'].includes(hanAuth.role)) stats();
  } catch (error) {
    toast(error.message);
  }
}
async function offerRecordIdentityChain(doc) {
  let matches = [],
    after = '';
  async function more() {
    try {
      const result = await readIntakeJson(
        '/api/records/related?' + new URLSearchParams({ id: doc.id, after }),
      );
      const dialog = document.getElementById('sameIdentityChainDialog');
      const unchecked = new Set(
        [...(dialog?.querySelectorAll('[data-identity-chain]:not(:checked)') || [])].map(
          (c) => c.dataset.identityChain,
        ),
      );
      matches.push(...result.items);
      after = result.next;
      offerSameIdentityChain(doc, matches);
      const current = document.getElementById('sameIdentityChainDialog');
      if (!current || !matches.length) return;
      current.querySelectorAll('[data-identity-chain]').forEach((c) => {
        if (unchecked.has(c.dataset.identityChain)) c.checked = false;
      });
      if (after) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Diğer eşleşen dosyaları göster';
        button.onclick = () => {
          button.disabled = true;
          more();
        };
        current.querySelector('.actions').prepend(button);
      }
    } catch (error) {
      toast(error.message);
    }
  }
  return more();
}

const payoutRecordState = { key: '', cursors: [''], index: 0, request: null, formRequest: null };
const payoutClientCache = new Map();
function payoutFilterClients() {
  const c = payoutClientCache.get(clientPayoutFilter) || db.clients.find((c) => c.id === clientPayoutFilter);
  return c ? [c] : [];
}
async function loadRecordPayouts() {
  const state = payoutRecordState,
    filters = {
      ...clientPayoutExtraFilters,
      client: clientPayoutFilter,
      start: clientPayoutStart,
      end: clientPayoutEnd,
    };
  const key = JSON.stringify(filters);
  if (key !== state.key) {
    state.key = key;
    state.cursors = [''];
    state.index = 0;
  }
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  const open = $('#clientPayoutFilterSection')?.open,
    marker = document.createElement('p');
  marker.textContent = 'Ödeme listesi yükleniyor…';
  marker.setAttribute('role', 'status');
  $('#content').replaceChildren(marker);
  try {
    const data = await recordReportFetch(
      '/api/records/client-payouts?' +
        new URLSearchParams({ ...filters, limit: 50, after: state.cursors[state.index] }),
      request.signal,
    );
    if (!marker.isConnected || state.request !== request) return;
    if (!data.items.length && state.index > 0) {
      state.index = 0;
      state.cursors = [''];
      return loadRecordPayouts();
    }
    clientPayoutPage(data);
    if (open) $('#clientPayoutFilterSection').open = true;
  } catch (error) {
    if (error.name === 'AbortError' || !marker.isConnected || state.request !== request) return;
    marker.textContent = error.message;
    const retry = document.createElement('button');
    retry.textContent = 'Yeniden Dene';
    retry.onclick = loadRecordPayouts;
    marker.after(retry);
  }
}
function bindRecordPayoutPage(data) {
  const state = payoutRecordState,
    footer = document.createElement('div');
  footer.className = 'tablefoot';
  footer.innerHTML = `<span>${data.totals.count === '0' ? 0 : state.index * 50 + 1}–${state.index * 50 + data.items.length} / ${esc(data.totals.count)} dosya · Toplamlar tüm filtre sonucunu kapsar.</span><div class="toolbar"><button class="secondary" id="previousPayout" ${state.index ? '' : 'disabled'}>Önceki</button><button class="secondary" id="nextPayout" ${data.next ? '' : 'disabled'}>Sonraki</button></div>`;
  $('#content').lastElementChild.append(footer);
  $('#previousPayout').onclick = () => {
    if (state.index) {
      state.index--;
      loadRecordPayouts();
    }
  };
  $('#nextPayout').onclick = () => {
    if (data.next) {
      state.cursors[++state.index] = data.next;
      loadRecordPayouts();
    }
  };
  const select = $('#clientPayoutFilter'),
    input = document.createElement('input');
  input.type = 'search';
  input.id = 'payoutClientLookup';
  input.dataset.optional = 'true';
  input.placeholder = 'Müvekkil adı veya kimlik ara…';
  input.setAttribute('aria-label', 'Ödeme için müvekkil ara');
  select.before(input);
  const hint = document.createElement('small');
  select.after(hint);
  const matches = document.createElement('div');
  matches.id = 'payoutClientMatches';
  matches.setAttribute('role', 'listbox');
  matches.style.cssText = 'max-height:240px;overflow:auto;border:1px solid #dce3e9;border-radius:8px';
  matches.hidden = true;
  input.after(matches);
  input.setAttribute('aria-controls', matches.id);
  input.setAttribute('aria-expanded', 'false');
  input.value = payoutClientCache.get(select.value)?.name || '';
  let timer, controller;
  const search = async () => {
    controller?.abort();
    const req = new AbortController();
    controller = req;
    const query = input.value.trim();
    hint.textContent = 'Müvekkiller aranıyor…';
    try {
      const result = await recordReportFetch(
        '/api/records/clients?' + new URLSearchParams({ q: query, limit: '50' }),
        req.signal,
      );
      if (!input.isConnected || controller !== req || input.value.trim() !== query) return;
      const selected = select.value,
        current = [...select.options].find((o) => o.value === selected);
      select.replaceChildren(new Option('Tüm Müvekkiller', ''));
      if (selected && current && !result.items.some((c) => c.id === selected)) select.append(current);
      for (const c of result.items) {
        payoutClientCache.set(c.id, { id: c.id, name: c.name || c.label });
        select.append(new Option(c.name || c.label, c.id));
      }
      select.value = selected;
      matches.replaceChildren();
      for (const c of result.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'option');
        button.style.cssText =
          'display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid #edf0f3;background:white';
        button.textContent = c.name || c.label;
        button.onclick = () => {
          select.value = c.id;
          input.value = c.name || c.label;
          matches.hidden = true;
          input.setAttribute('aria-expanded', 'false');
          select.form.requestSubmit();
        };
        matches.append(button);
      }
      matches.hidden = !result.items.length;
      input.setAttribute('aria-expanded', String(!matches.hidden));
      hint.textContent = result.items.length
        ? `${result.count} müvekkil bulundu.${result.next ? ' İlk 50 sonuç; aramayı daraltabilirsiniz.' : ''} Seçmek için ismine tıklayın.`
        : 'Eşleşen müvekkil bulunamadı.';
    } catch (error) {
      if (error.name !== 'AbortError' && input.isConnected) hint.textContent = error.message;
    }
  };
  input.onfocus = search;
  input.oninput = () => {
    clearTimeout(timer);
    controller?.abort();
    matches.hidden = true;
    timer = setTimeout(search, 200);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      matches.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
    if (event.key === 'ArrowDown' && !matches.hidden) {
      event.preventDefault();
      matches.querySelector('button')?.focus();
    }
    if (event.key === 'Enter' && !matches.hidden) {
      event.preventDefault();
      matches.querySelector('button')?.click();
    }
  });
  input.closest('label').addEventListener('focusout', (event) => {
    if (!input.closest('label').contains(event.relatedTarget)) {
      matches.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });
}
async function loadRecordPayoutForm(id) {
  payoutRecordState.formRequest?.abort();
  const request = new AbortController();
  payoutRecordState.formRequest = request;
  const screen = $('#content').firstElementChild;
  try {
    const data = await recordReportFetch(
      '/api/records/client-payout?' + new URLSearchParams({ id }),
      request.signal,
    );
    if (payoutRecordState.formRequest !== request || !screen?.isConnected) return;
    for (const key of ['entitlement', 'paid', 'remaining']) {
      const n = Number(data.totals[key]);
      if (!Number.isSafeInteger(n)) throw Error('Bu tutar tek işlem sınırını aşıyor.');
      data.totals[key] = n;
    }
    window.hanAccountBalances = data.accountBalances;
    clientPayoutForm(id, data);
  } catch (error) {
    if (error.name !== 'AbortError' && screen?.isConnected) toast(error.message);
  }
}
function payoutAccountField(accounts) {
  return `<label class="field">Paranın Çıktığı Kasa / Banka *<select name="accountId" required><option value="">Hesap seçin</option>${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label>`;
}
function bindRecordPayoutSubmit(form, dialog, data, requestId) {
  let pending = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    const screen = $('#content').firstElementChild;
    try {
      const v = Object.fromEntries(new FormData(form)),
        amount = v.paymentMode === 'full' ? data.totals.remaining : financeCents(v.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > data.totals.remaining)
        throw Error('Geçerli ve kalan tutarı aşmayan bir ödeme girin.');
      if (
        !data.accounts.some((a) => a.id === v.accountId) ||
        BigInt(data.accountBalances[v.accountId] || '0') < BigInt(amount)
      )
        throw Error('Hesap seçin ve yeterli bakiye olduğundan emin olun.');
      legalDate(v.date);
      if (v.date > businessDate() || (data.record.closedDate && v.date < data.record.closedDate))
        throw Error('Geçerli bir ödeme tarihi seçin.');
      if (!v.note.trim()) throw Error('Ödeme açıklamasını girin.');
      pending = true;
      submit.disabled = true;
      const response = await fetch('/api/client-payout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: requestId,
          documentId: data.record.id,
          clientId: data.record.client,
          accountId: v.accountId,
          amount,
          date: v.date,
          note: v.note.trim(),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Ödeme kaydedilemedi.');
      if (result.accountBalances) window.hanAccountBalances = result.accountBalances;
      dialog.close();
      toast('Müvekkil ödemesi kaydedildi.');
      if (page === 'accounting' && screen?.isConnected) loadRecordPayouts();
      const borrower = $('#borrowerDetail');
      if (borrower?.open && borrower.dataset.borrowerId === data.record.id)
        await recordAction(data.record.id, () => borrowerDetail(data.record.id));
      else if (page === 'clients' && screen?.isConnected) render();
    } catch (error) {
      toast(error.message);
    } finally {
      pending = false;
      submit.disabled = false;
    }
  };
}

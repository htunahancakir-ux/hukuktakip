const recordAccountingState = { key: '', cursors: [''], index: 0, request: null };
async function loadRecordAccounting() {
  const state = recordAccountingState,
    key = JSON.stringify([accountingFilter, movementFilters]);
  if (key !== state.key) {
    state.key = key;
    state.cursors = [''];
    state.index = 0;
  }
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  const open = document.getElementById('accountingFilterSection')?.open;
  const marker = document.createElement('p');
  marker.textContent = 'Hesap hareketleri yükleniyor…';
  marker.setAttribute('role', 'status');
  // Keep the drawn screen in place while refreshing, so the page does not jump.
  const content = $('#content'),
    drawn = !!content.querySelector('.account-ledger');
  content.querySelectorAll('.acc-loading').forEach((old) => old.remove());
  if (drawn) {
    marker.className = 'acc-loading';
    content.prepend(marker);
  } else content.replaceChildren(marker);
  try {
    const response = await fetch(
      '/api/records/accounting?' +
        new URLSearchParams({
          ...movementFilters,
          account: accountingFilter,
          limit: 50,
          after: state.cursors[state.index],
        }),
      {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: request.signal,
        headers: { 'X-Han-Request': '1' },
      },
    );
    const data = await response.json();
    if (!marker.isConnected || state.request !== request) return;
    if (!response.ok) throw Error(data.error || 'Muhasebe bilgileri alınamadı.');
    window.hanAccountBalances = data.balances;
    accounting.accounts = structuredClone(data.accounts);
    const baseline = hanDataBaselines.get('hanhukuk-accounting-v1');
    if (baseline) baseline.accounts = structuredClone(data.accounts);
    accountingPage(data);
    if (open) $('#accountingFilterSection').open = true;
  } catch (error) {
    if (error.name === 'AbortError' || !marker.isConnected || state.request !== request) return;
    marker.className = '';
    content.replaceChildren(marker);
    marker.textContent = error.message;
    const retry = document.createElement('button');
    retry.className = 'secondary';
    retry.textContent = 'Yeniden Dene';
    retry.onclick = loadRecordAccounting;
    marker.after(retry);
  }
}
function bindAccountingPagination(data) {
  const state = recordAccountingState;
  const footer = document.createElement('div');
  footer.className = 'tablefoot';
  footer.innerHTML = `<span>${data.totals.count === '0' ? 0 : state.index * 50 + 1}–${state.index * 50 + data.items.length} / ${esc(data.totals.count)} hareket · Toplamlar filtreye uyan tüm hareketleri kapsar.</span><div class="toolbar"><button class="secondary" id="previousAccounting" ${state.index ? '' : 'disabled'}>Önceki</button><button class="secondary" id="nextAccounting" ${data.next ? '' : 'disabled'}>Sonraki</button></div>`;
  ($('#content .acc-ledger-scroll') || $('#content').lastElementChild.lastElementChild).after(footer);
  $('#previousAccounting').onclick = () => {
    if (state.index) {
      state.index--;
      loadRecordAccounting();
    }
  };
  $('#nextAccounting').onclick = () => {
    if (data.next) {
      state.cursors[++state.index] = data.next;
      loadRecordAccounting();
    }
  };
}

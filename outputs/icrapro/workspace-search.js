function setupWorkspaceSearch() {
  const form = document.getElementById('workspaceSearch');
  if (!form) return;
  const input = document.getElementById('workspaceSearchQuery');
  const results = document.getElementById('workspaceSearchResults');
  let timer;
  let controller;
  let selected = -1;
  let items = [];

  function setOpen(open) {
    results.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) input.removeAttribute('aria-activedescendant');
  }

  function close() {
    clearTimeout(timer);
    controller?.abort();
    items = [];
    selected = -1;
    setOpen(false);
  }

  function show(message) {
    results.textContent = message;
    setOpen(true);
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    close();
    input.value = '';
    if (window.hanRecordsEnabled && item.type === 'document' && hanPageAllowed('documents'))
      return recordAction(item.id, () => borrowerDetail(item.id));
    if (window.hanRecordsEnabled && item.type === 'client' && hanPageAllowed('clients'))
      return clientModal(item.id);
    try {
      db = authApi('/api/data?key=icrapro-v1');
      if (item.type === 'client' && hanPageAllowed('clients')) {
        if (!db.clients.some((row) => row.id === item.id)) return toast('Müvekkil kaydı artık bulunamadı.');
        clientModal(item.id);
      } else if (item.type === 'document' && hanPageAllowed('documents')) {
        const row = db.docs.find((record) => record.id === item.id);
        if (!row) return toast('Evrak kaydı artık bulunamadı.');
        if (['ceo', 'admin'].includes(hanAuth.role)) borrowerDetail(item.id);
        else staffBorrowerDetail(item.id, row);
      }
    } catch (error) {
      toast(error.message || 'Kayıt açılamadı.');
    }
  }

  async function search(query) {
    const request = new AbortController();
    controller = request;
    show('Aranıyor…');
    try {
      const response = await fetch('/api/search?q=' + encodeURIComponent(query), {
        signal: request.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw Error('Arama tamamlanamadı. Yeniden deneyin.');
      const data = await response.json();
      if (request.signal.aborted || input.value.trim() !== query) return;
      items = data.items;
      if (!items.length) return show('Eşleşen kayıt bulunamadı.');
      results.innerHTML = items
        .map(
          (item, index) => `<div id="workspaceSearchOption-${index}" class="workspace-search-result"
        data-result="${index}" role="option" aria-selected="false">
        <span class="workspace-search-kind">${item.type === 'client' ? 'Müvekkil' : 'Evrak'}</span>
        <span><strong>${esc(item.label)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ''}</span>
      </div>`,
        )
        .join('');
    } catch (error) {
      if (!request.signal.aborted) show(error.message);
    }
  }

  function queueSearch() {
    close();
    const query = input.value.trim();
    if (query.length < 2) return;
    timer = setTimeout(() => search(query), 200);
  }

  input.addEventListener('input', queueSearch);
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2 && results.hidden) queueSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (!items.length || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (selected < 0) selected = event.key === 'ArrowDown' ? 0 : items.length - 1;
    else selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    [...results.querySelectorAll('[role="option"]')].forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === selected));
      if (index === selected) option.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', 'workspaceSearchOption-' + selected);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    choose(Math.max(0, selected));
  });
  results.addEventListener('click', (event) => {
    const row = event.target.closest('[data-result]');
    if (row) choose(Number(row.dataset.result));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!form.contains(event.target)) close();
  });
  form.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !form.contains(event.relatedTarget)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'k' &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });
}

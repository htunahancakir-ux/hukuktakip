const folioWindows = new Map();
const folioLeases = new Map();
let folioClickSource = null;
function folioReadControl(control) {
  return (
    control.matches(
      '[role="tab"],[data-borrower-tab],[data-pin-close],[data-pin-open],.sheet-pin-button,.sheet-resize-button,.sheet-corner-resize,[data-sheet-nav]',
    ) ||
    /^(close|cancel|previousBorrower|nextBorrower)/i.test(control.id) ||
    (control.tagName === 'BUTTON' &&
      /^(Kapat|Önceki|Sonraki|Büyüt|Küçült|Yazdır|PDF)/.test(control.textContent.trim()))
  );
}
function renderFolioLease(root, entry) {
  let banner = root.querySelector('[data-folio-lock-banner]');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'notice';
    banner.dataset.folioLockBanner = '';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'margin:8px 12px;padding:10px 14px;border:1px solid #d6a44b;background:#fff8e8;';
    const head = root.querySelector('.panelhead');
    if (head) head.after(banner);
    else root.prepend(banner);
  }
  const message = entry.editable
    ? 'İşlem modu · Bu föy sizde açık.'
    : entry.error ||
      (entry.ownerName
        ? 'İzleme modu · Föy ' + entry.ownerName + ' kullanıcısında açık. Kapandığında işlem yapabilirsiniz.'
        : 'İzleme modu · Föyün işlem yetkisi kontrol ediliyor.');
  if (banner.textContent !== message) banner.textContent = message;
  root.dataset.folioReadOnly = entry.editable ? 'false' : 'true';
  for (const control of root.querySelectorAll('input,select,textarea,button')) {
    if (folioReadControl(control)) continue;
    if (!entry.editable && !control.disabled) {
      control.disabled = true;
      control.dataset.folioDisabled = 'true';
    } else if (entry.editable && control.dataset.folioDisabled) {
      control.disabled = false;
      delete control.dataset.folioDisabled;
    }
  }
}
async function requestFolioLease(id, action, keepalive = false, viewId = folioLeases.get(id)?.viewId) {
  const res = await fetch('/api/documents/lease', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive,
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    body: JSON.stringify({ documentId: id, viewId, action }),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || 'Föy kilidi kontrol edilemedi.');
  return data;
}
function openFolioRoots(id) {
  return [...folioWindows]
    .filter(([root, key]) => key === id && root.isConnected && root.open)
    .map(([root]) => root);
}
function bindFolioLock(root, id) {
  if (!window.hanRecordsEnabled || !root || !id) return;
  folioWindows.set(root, id);
  root.dataset.folioDocument = id;
  let entry = folioLeases.get(id);
  if (!entry) {
    entry = { editable: false, busy: false, viewId: crypto.randomUUID() };
    folioLeases.set(id, entry);
  }
  renderFolioLease(root, entry);
  void pollFolioLease(id, entry);
}
async function pollFolioLease(id, entry) {
  if (entry.busy) return;
  entry.busy = true;
  try {
    const data = await requestFolioLease(id, 'acquire', false, entry.viewId);
    if (folioLeases.get(id) !== entry || !openFolioRoots(id).length) {
      if (data.editable) void requestFolioLease(id, 'release', true, entry.viewId).catch(() => {});
      return;
    }
    if (data.editable && !entry.editable) {
      // Refresh revision and financial data before enabling a former viewer.
      let refreshed = false;
      await recordAction(id, () => {
        refreshed = true;
        for (const root of openFolioRoots(id)) {
          if (root.id === 'borrowerDetail') borrowerDetail(id);
          else if (root.id === 'editBorrowerDialog') editBorrower(id);
          else if (root.querySelector('#financeTerms')) financialOperations(id);
          else if (root.querySelector('#closeStaffBorrower')) staffBorrowerDetail(id);
        }
      });
      if (!refreshed) throw Error('Föy güncellenemedi. İşlem yetkisi yeniden kontrol edilecek.');
    }
    entry.editable = data.editable;
    entry.ownerName = data.ownerName;
    entry.error = data.editable || data.ownerName ? '' : 'İzleme modu · Bu hesap kayıt değiştiremez.';
  } catch (error) {
    entry.editable = false;
    entry.error = 'İzleme modu · ' + error.message;
  } finally {
    entry.busy = false;
    for (const root of openFolioRoots(id)) renderFolioLease(root, entry);
  }
}
function sweepFolioWindows() {
  for (const [root, id] of folioWindows) {
    if (root.isConnected && root.open) continue;
    folioWindows.delete(root);
    delete root.dataset.folioDocument;
    delete root.dataset.folioReadOnly;
  }
  for (const [id, entry] of folioLeases)
    if (!openFolioRoots(id).length) {
      folioLeases.delete(id);
      void requestFolioLease(id, 'release', true, entry.viewId).catch(() => {});
    }
}
document.addEventListener(
  'click',
  (event) => {
    const root = event.target.closest('[data-folio-document]');
    folioClickSource = root?.dataset.folioDocument || null;
    const control = event.target.closest('button,input,select,textarea');
    if (root?.dataset.folioReadOnly === 'true' && control && !folioReadControl(control)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
for (const type of ['submit', 'contextmenu'])
  document.addEventListener(
    type,
    (event) => {
      if (event.target.closest('[data-folio-read-only="true"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
new MutationObserver((records) => {
  if (!window.hanRecordsEnabled || !window.document) return;
  // Child dialogs opened from a folio inherit that folio's lock.
  const opened = new Set();
  for (const record of records) {
    if (record.type === 'attributes' && record.target.matches('dialog[open]')) opened.add(record.target);
    for (const node of record.addedNodes || [])
      if (node.nodeType === 1) {
        if (node.matches('dialog[open]')) opened.add(node);
        for (const root of node.querySelectorAll('dialog[open]')) opened.add(root);
      }
  }
  for (const root of opened) {
    if (!folioWindows.has(root) && folioClickSource && !root.classList.contains('pinned-borrower-sheet'))
      bindFolioLock(root, folioClickSource);
  }
  sweepFolioWindows();
  for (const [root, id] of folioWindows) {
    const entry = folioLeases.get(id);
    if (entry) renderFolioLease(root, entry);
  }
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
setInterval(() => {
  sweepFolioWindows();
  for (const [id, entry] of folioLeases) void pollFolioLease(id, entry);
}, 5000);
window.addEventListener('pagehide', () => {
  for (const id of folioLeases.keys()) void requestFolioLease(id, 'release', true).catch(() => {});
  for (const entry of folioLeases.values()) entry.editable = false;
});
window.addEventListener('pageshow', () => {
  for (const [id, entry] of folioLeases) void pollFolioLease(id, entry);
});

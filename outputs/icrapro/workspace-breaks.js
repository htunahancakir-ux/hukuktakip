let staffBreakTimer,
  staffBreakUpdatedAt = 0,
  staffBreakBusy = false,
  pendingBreakRequest;
function staffBreakFeedback(message) {
  const host = document.getElementById('staffBreakLockFeedback');
  if (host && document.getElementById('staffBreakLock')?.open) host.textContent = message;
  else if (typeof toast === 'function') toast(message);
}
function renderStaffBreakButton() {
  const button = document.getElementById('staffBreakButton'),
    status = document.getElementById('staffBreakStatus');
  if (!button || hanAuth?.role !== 'staff') return;
  const active = hanAuth.activeBreak;
  button.textContent = active ? 'Mola Bitti' : 'Molaya Çıkıyorum';
  button.dataset.onBreak = String(!!active);
  button.disabled = staffBreakBusy;
  if (active) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(active.startedAt)) / 1000));
    status.textContent = `Moladasınız · ${Math.floor(seconds / 60)} dk ${seconds % 60} sn`;
  } else status.textContent = '';
  renderStaffBreakLock();
}
function renderStaffBreakLock() {
  let dialog = document.getElementById('staffBreakLock');
  if (!hanAuth?.activeBreak) {
    if (dialog?.open) dialog.close();
    return;
  }
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'staffBreakLock';
    dialog.setAttribute('aria-labelledby', 'staffBreakLockTitle');
    dialog.innerHTML =
      '<div class="formbody"><h2 id="staffBreakLockTitle">Moladasınız</h2><p>Hesabınız işlem yapmaya kapalı. Devam etmek için molanızı bitirin.</p><strong id="staffBreakLockTime" role="status" aria-live="off"></strong><label class="field staff-break-unlock">Giriş Şifreniz<input type="password" id="staffBreakUnlockPassword" autocomplete="current-password" maxlength="128" placeholder="Molayı bitirmek için şifreniz"></label><p id="staffBreakLockFeedback" role="alert"></p></div><div class="actions"><button type="button" class="secondary" id="staffBreakLockLogout">Çıkış</button><button type="button" class="primary" id="staffBreakLockEnd">Mola Bitti</button></div>';
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    document.body.append(dialog);
    dialog.querySelector('#staffBreakUnlockPassword').onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        dialog.querySelector('#staffBreakLockEnd').click();
      }
    };
    dialog.querySelector('#staffBreakLockEnd').onclick = () =>
      document.getElementById('staffBreakButton')?.onclick();
    dialog.querySelector('#staffBreakLockLogout').onclick = async () => {
      const signOut = document.getElementById('signOut');
      if (typeof signOut?.onclick === 'function') return signOut.onclick();
      try {
        const response = await fetch('/api/logout', {
          method: 'POST',
          headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) throw Error('Oturum kapatılamadı. Tekrar deneyin.');
        location.reload();
      } catch (error) {
        staffBreakFeedback(error.message);
      }
    };
  }
  dialog.querySelector('#staffBreakLockTime').textContent =
    document.getElementById('staffBreakStatus')?.textContent || '';
  dialog.querySelectorAll('button').forEach((button) => {
    button.disabled = staffBreakBusy;
  });
  if (!dialog.open) dialog.showModal();
}
document.addEventListener(
  'click',
  (event) => {
    if (!hanAuth?.activeBreak || event.target.closest?.('#staffBreakLock, #staffBreakButton, #signOut'))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);
document.addEventListener(
  'submit',
  (event) => {
    if (!hanAuth?.activeBreak) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);
function applyStaffBreakStatus(activeBreak, observedAt = Date.now()) {
  if (hanAuth?.role === 'ceo') activeBreak = null;
  if (hanAuth?.role !== 'staff') return;
  if (observedAt < staffBreakUpdatedAt) return;
  staffBreakUpdatedAt = observedAt;
  hanAuth.activeBreak = activeBreak || null;
  if (
    (pendingBreakRequest?.action === 'start' && activeBreak) ||
    (pendingBreakRequest?.action === 'end' && activeBreak?.id !== pendingBreakRequest.breakId)
  )
    pendingBreakRequest = null;
  renderStaffBreakButton();
}
function setupStaffBreakButton() {
  if (hanAuth?.role !== 'staff') return;
  const slot = document.getElementById('accountSlot')?.parentElement || document.querySelector('header');
  if (!slot) return;
  let host = document.getElementById('staffBreakControls');
  if (!host) {
    host = document.createElement('div');
    host.id = 'staffBreakControls';
    host.className = 'staff-break-controls';
    host.innerHTML =
      '<button type="button" class="secondary" id="staffBreakButton"></button><small id="staffBreakStatus" role="status" aria-live="off"></small>';
    const signOut = document.getElementById('signOut');
    if (signOut?.parentElement === slot) slot.insertBefore(host, signOut);
    else slot.append(host);
  }
  const button = document.getElementById('staffBreakButton');
  button.onclick = async () => {
    if (staffBreakBusy) return;
    const active = hanAuth.activeBreak;
    if (!pendingBreakRequest)
      pendingBreakRequest = active
        ? { action: 'end', breakId: active.id }
        : { action: 'start', requestId: crypto.randomUUID() };
    const passwordInput = document.getElementById('staffBreakUnlockPassword');
    if (active && !passwordInput?.value) {
      staffBreakFeedback('Molayı bitirmek için giriş şifrenizi girin.');
      passwordInput?.focus();
      return;
    }
    const operation = { ...pendingBreakRequest, ...(active ? { password: passwordInput.value } : {}) };
    staffBreakBusy = true;
    renderStaffBreakButton();
    try {
      const response = await fetch('/api/staff-breaks', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(operation),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) pendingBreakRequest = null;
        throw Error(result.error || 'Mola kaydedilemedi.');
      }
      const ending = operation.action === 'end';
      pendingBreakRequest = null;
      applyStaffBreakStatus(result.activeBreak);
      if (window.staffBreakGateOnly && !result.activeBreak) {
        location.reload();
        return;
      }
      const seconds = result.lastBreak?.durationSeconds;
      staffBreakFeedback(
        ending && Number.isFinite(seconds)
          ? `Molanız tamamlandı: ${Math.floor(seconds / 60)} dk ${seconds % 60} sn. Yöneticilere bildirildi.`
          : 'Mola başlangıcı yöneticilere bildirildi.',
      );
    } catch (error) {
      staffBreakFeedback(error.message || 'Mola durumu kaydedilemedi. Tekrar deneyin.');
    } finally {
      staffBreakBusy = false;
      if (passwordInput) passwordInput.value = '';
      renderStaffBreakButton();
    }
  };
  clearInterval(staffBreakTimer);
  staffBreakTimer = setInterval(renderStaffBreakButton, 1000);
  renderStaffBreakButton();
}

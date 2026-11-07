let staffBreakTimer,
  staffBreakUpdatedAt = 0,
  staffBreakBusy = false,
  pendingBreakRequest;
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
}
function applyStaffBreakStatus(activeBreak, observedAt = Date.now()) {
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
    const operation = pendingBreakRequest;
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
      const seconds = result.lastBreak?.durationSeconds;
      toast(
        ending && Number.isFinite(seconds)
          ? `Molanız tamamlandı: ${Math.floor(seconds / 60)} dk ${seconds % 60} sn. Yöneticilere bildirildi.`
          : 'Mola başlangıcı yöneticilere bildirildi.',
      );
    } catch (error) {
      toast(error.message || 'Mola durumu kaydedilemedi. Tekrar deneyin.');
    } finally {
      staffBreakBusy = false;
      renderStaffBreakButton();
    }
  };
  clearInterval(staffBreakTimer);
  staffBreakTimer = setInterval(renderStaffBreakButton, 1000);
  renderStaffBreakButton();
}

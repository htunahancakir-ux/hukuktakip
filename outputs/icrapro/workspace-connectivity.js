// Tells the user when the computer has no connection. While offline, auth.js does not send
// requests at all, so background refreshes stay quiet and resume by themselves afterwards.
(() => {
  function banner() {
    let el = document.getElementById('hanOfflineBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hanOfflineBanner';
      el.setAttribute('role', 'alert');
      el.textContent = 'İnternet bağlantısı yok. Bağlantı gelene kadar kayıt yapılamaz.';
      if (typeof el.showPopover === 'function') el.setAttribute('popover', 'manual');
      document.body.append(el);
    }
    return el;
  }
  const leaveTopLayer = (el) => {
    try {
      if (el.matches(':popover-open')) el.hidePopover();
    } catch {}
  };
  function update(announce) {
    if (navigator.onLine === false) {
      const el = banner();
      // Re-enter the top layer so the notice sits above a window that is already open.
      leaveTopLayer(el);
      try {
        el.showPopover?.();
      } catch {}
      return;
    }
    const el = document.getElementById('hanOfflineBanner');
    if (!el) return;
    leaveTopLayer(el);
    el.remove();
    if (announce && typeof toast === 'function') toast('İnternet bağlantısı geri geldi.');
  }
  window.addEventListener('offline', () => update(true));
  window.addEventListener('online', () => update(true));
  if (document.body) update(false);
  else document.addEventListener('DOMContentLoaded', () => update(false));
})();

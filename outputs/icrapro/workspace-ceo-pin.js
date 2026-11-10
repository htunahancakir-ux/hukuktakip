window.hanPinProofs = {};
function ceoPinScope(url) {
  if (window.hanAuth?.role === 'ceo') return null;
  const p = new URL(url, location.origin).pathname;
  if (p === '/api/operations/delete') return 'delete';
  if (
    [
      '/api/users',
      '/api/users/password',
      '/api/personnel-save',
      '/api/voip/permissions',
      '/api/password-reset/send',
    ].includes(p)
  )
    return 'permissions';
  if (
    [
      '/api/ai/config',
      '/api/ai/test',
      '/api/whatsapp/config',
      '/api/whatsapp/settings',
      '/api/voip/config',
      '/api/voip/test',
    ].includes(p)
  )
    return 'integrations';
  return null;
}
async function requireCeoPin() {
  return true;
}

function showCeoPinSettings() {
  let config;
  try {
    config = authApi('/api/ceo-pin/status');
  } catch (error) {
    return toast(error.message);
  }
  const dialog = document.getElementById('modal');
  dialog.innerHTML = `<form id="ceoPinSettings"><div class="panelhead"><h2>Güvenlik PIN’i Belirle</h2></div><div class="formbody grid"><label class="field full">Mevcut hesap şifresi<input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field">Yeni PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><label class="field">PIN tekrar<input name="confirm" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label>${[
    ['integrations', 'Entegrasyonlar'],
    ['permissions', 'Yetkilendirme'],
    ['delete', 'İşlem silme'],
  ]
    .map(
      ([id, label]) =>
        `<label class="settings-check"><input type="checkbox" name="${id}" ${config.scopes.includes(id) ? 'checked' : ''}>${label}</label>`,
    )
    .join(
      '',
    )}<p class="full" role="status"></p></div><div class="actions"><button type="button" class="secondary" id="cancelCeoPin">Kapat</button><button type="submit" class="primary">PIN’i Kaydet</button></div></form>`;
  document.getElementById('cancelCeoPin').onclick = () => dialog.close();
  const form = document.getElementById('ceoPinSettings');
  form.onsubmit = (event) => {
    event.preventDefault();
    if (form.elements.pin.value !== form.elements.confirm.value) {
      form.querySelector('[role="status"]').textContent = 'PIN’ler aynı olmalıdır.';
      return;
    }
    try {
      authApi('/api/ceo-pin/config', 'POST', {
        currentPassword: form.elements.currentPassword.value,
        pin: form.elements.pin.value,
        scopes: ['integrations', 'permissions', 'delete'].filter((id) => form.elements[id].checked),
      });
      window.hanPinProofs = {};
      form.reset();
      dialog.close();
      toast('Güvenlik PIN’i kaydedildi.');
    } catch (error) {
      form.querySelector('[role="status"]').textContent = error.message;
    }
  };
  if (!dialog.open) dialog.showModal();
}

const originalPinFetch = window.fetch?.bind(window);
window.fetch = async (url, options = {}) => {
  if (typeof url !== 'string' || new URL(url, location.origin).origin !== location.origin)
    return originalPinFetch(url, options);
  const scope = ceoPinScope(url);
  const headers = new Headers(options.headers);
  if (scope && window.hanPinProofs[scope]) headers.set('X-Han-Pin-Proof', window.hanPinProofs[scope]);
  const response = await originalPinFetch(url, { ...options, headers });
  if (scope && response.status === 423) {
    const error = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (error.code === 'CEO_PIN_REQUIRED' && (await requireCeoPin(scope))) {
      headers.delete('X-Han-Pin-Proof');
      return originalPinFetch(url, { ...options, headers });
    }
  }
  return response;
};

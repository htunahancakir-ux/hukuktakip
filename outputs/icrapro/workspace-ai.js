function aiSettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('Yapay zeka ayarlarını yalnızca CEO yönetebilir.');
  let config;
  try {
    config = authApi('/api/ai/config');
  } catch (error) {
    return toast(error.message);
  }
  const gateway = config.provider === 'vercel-ai-gateway';
  $('#content').innerHTML = `${settingsSectionTabs('ai')}<section class="panel">
    <div class="panelhead"><div><h2>Yapay Zeka</h2><p>Görüşmelerin otomatik özetini oluşturacak sağlayıcıyı seçin.</p></div><span class="badge">${config.enabled ? 'Etkin' : 'Kapalı'}</span></div>
    <form id="aiConfigForm"><div class="formbody grid">
      <label class="settings-check full"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}> Otomatik görüşme özetlerini aç</label>
      <label class="field">Sağlayıcı<select name="provider"><option value="vercel-ai-gateway" ${gateway ? 'selected' : ''}>Vercel AI Gateway — diğer model sağlayıcıları</option><option value="openai" ${gateway ? '' : 'selected'}>OpenAI API — kendi API anahtarım</option></select><small>AI Gateway’de model adını <code>sağlayıcı/model</code> biçiminde değiştirerek desteklenen başka sağlayıcıları kullanabilirsiniz.</small></label>
      <label class="field">Model<input name="model" required maxlength="128" value="${esc(config.model)}" placeholder="openai/gpt-4.1-mini"></label>
      <label class="field full" id="aiApiKeyField" ${gateway ? 'hidden' : ''}>OpenAI API anahtarı<input name="apiKey" type="password" maxlength="512" autocomplete="new-password" data-optional="true" placeholder="${config.apiKeySaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'OpenAI API anahtarını girin'}"><small>Anahtar yalnızca bu istek sırasında sunucuya gider; şifrelenerek saklanır ve tekrar görüntülenmez.</small></label>
      <label class="settings-check full" id="aiClearKeyField" ${!config.apiKeySaved || gateway ? 'hidden' : ''}><input type="checkbox" name="clearApiKey"> Kayıtlı OpenAI API anahtarını sil</label>
      <div class="notice full" id="aiProviderNotice"></div>
      <details class="full"><summary>Gizlilik ve sağlayıcı seçimi</summary><p>Özet oluşturulurken görüşme notları seçtiğiniz yapay zeka sağlayıcısına gönderilir. Ham notlar uygulamada korunur; oluşturulan özet 300 karakterle sınırlıdır.</p><p>Vercel AI Gateway, Vercel dağıtımındaki kimlik doğrulamayla çalışır. OpenAI API seçildiğinde kendi OpenAI anahtarınız şifreli saklanır. API anahtarları hiçbir kullanıcıya veya tarayıcıya geri gönderilmez.</p></details></div><div class="actions"><button class="primary" type="submit">Yapay Zeka Ayarlarını Kaydet</button></div></form>
  </section>`;
  bindSettingsSectionTabs();
  const form = $('#aiConfigForm');
  const updateProvider = () => {
    const usingGateway = form.elements.provider.value === 'vercel-ai-gateway';
    $('#aiApiKeyField').hidden = usingGateway;
    $('#aiClearKeyField').hidden = usingGateway || !config.apiKeySaved;
    $('#aiProviderNotice').textContent = usingGateway
      ? 'Vercel AI Gateway seçili. Model alanında desteklenen sağlayıcı/model adını kullanabilirsiniz; bu seçenek için uygulamaya ayrı API anahtarı girilmez.'
      : config.encryptionReady
        ? 'OpenAI anahtarı AES-256-GCM ile şifrelenerek saklanır. Kayıtlı anahtar gösterilmez.'
        : 'Anahtar saklama şifrelemesi Vercel ortamında hazır değil. Önce AI_ENCRYPTION_KEY gizli değişkenini tanımlayın.';
  };
  form.elements.provider.onchange = updateProvider;
  updateProvider();
  form.onsubmit = (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(form));
    input.enabled = form.elements.enabled.checked;
    input.clearApiKey = form.elements.clearApiKey?.checked === true;
    input.provider = String(input.provider || '').trim();
    input.model = String(input.model || '').trim();
    input.apiKey = String(input.apiKey || '').trim();
    try {
      authApi('/api/ai/config', 'PUT', input);
      aiSettingsPage();
      toast('Yapay zeka ayarları kaydedildi. Yeni görüşme özetleri bu bağlantıyı kullanacak.');
    } catch (error) {
      toast(error.message);
    }
  };
}

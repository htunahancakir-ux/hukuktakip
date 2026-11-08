function aiSettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('Yapay zeka ayarlarını yalnızca CEO yönetebilir.');
  let config;
  try {
    config = authApi('/api/ai/config');
  } catch (error) {
    return toast(error.message);
  }
  const gateway = config.provider === 'vercel-ai-gateway';
  const models = Array.isArray(config.modelOptions) ? config.modelOptions : [];
  const knownModel = models.some((model) => model.id === config.model);
  const money = (value) =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value || 0));
  const tokens = (value) => new Intl.NumberFormat('tr-TR').format(Number(value || 0));
  const usage = config.usage || {};
  const modelOptions = models
    .map(
      (model) =>
        `<option value="${esc(model.id)}" ${model.id === config.model ? 'selected' : ''}>${esc(model.name)} — girdi $${money(model.input)} / çıktı $${money(model.output)} · 1 milyon token</option>`,
    )
    .join('');
  $('#content').innerHTML = `${settingsSectionTabs('ai')}<section class="panel">
    <div class="panelhead"><div><h2>Yapay Zeka</h2><p>Görüşmelerin otomatik özetini oluşturacak sağlayıcıyı seçin.</p></div><span class="badge">${config.enabled ? 'Etkin' : 'Kapalı'}</span></div>
    <form id="aiConfigForm"><div class="formbody grid">
      <label class="settings-check full"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}> Otomatik görüşme özetlerini aç</label>
      <label class="field">Sağlayıcı<select name="provider"><option value="vercel-ai-gateway" ${gateway ? 'selected' : ''}>Vercel AI Gateway — diğer model sağlayıcıları</option><option value="openai" ${gateway ? '' : 'selected'}>OpenAI API — kendi API anahtarım</option></select><small>AI Gateway’de model adını <code>sağlayıcı/model</code> biçiminde değiştirerek desteklenen başka sağlayıcıları kullanabilirsiniz.</small></label>
      <label class="field">Dil modeli (ucuzdan pahalıya)<select name="modelPreset">${modelOptions}<option value="__custom" ${knownModel ? '' : 'selected'}>Özel model adı gir…</option></select><small>Fiyatlar USD / 1 milyon token; girdi ve çıktı ayrı ücretlenir.</small></label>
      <label class="field full" id="aiCustomModelField" ${knownModel ? 'hidden' : ''}>Özel model adı<input name="model" required maxlength="128" value="${esc(config.model)}" placeholder="ör. anthropic/claude-sonnet-4"></label>
      <label class="field">Özet uzunluğu (karakter)<input name="summaryMaxChars" type="number" required min="100" max="2000" step="1" value="${config.summaryMaxChars}"><small>100–2.000 karakter. Bu ayarı değiştirince özetler yeni uzunlukla yeniden oluşturulur.</small></label>
      <label class="field full" id="aiApiKeyField" ${gateway ? 'hidden' : ''}>OpenAI API anahtarı<input name="apiKey" type="password" maxlength="512" autocomplete="new-password" data-optional="true" placeholder="${config.apiKeySaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'OpenAI API anahtarını girin'}"><small>Anahtar yalnızca bu istek sırasında sunucuya gider; şifrelenerek saklanır ve tekrar görüntülenmez.</small></label>
      <label class="settings-check full" id="aiClearKeyField" ${!config.apiKeySaved || gateway ? 'hidden' : ''}><input type="checkbox" name="clearApiKey"> Kayıtlı OpenAI API anahtarını sil</label>
      <div class="notice full" id="aiProviderNotice"></div>
      <section class="notice full" aria-label="AI kullanım istatistikleri"><strong>API kullanımı</strong><p><b>${tokens(usage.totalTokens)}</b> toplam token · ${tokens(usage.inputTokens)} girdi · ${tokens(usage.outputTokens)} çıktı · ${tokens(usage.requests)} başarılı AI isteği${usage.lastUsedAt ? ` · son kullanım: ${esc(new Date(usage.lastUsedAt).toLocaleString('tr-TR'))}` : ''}</p>${(usage.models || []).length ? `<small>${usage.models.map((row) => `${esc(row.model)}: ${tokens(row.totalTokens)} token (${tokens(row.requests)} istek)`).join(' · ')}</small>` : '<small>Henüz sağlayıcı tarafından token kullanımı döndürülmedi. Yerel yedek özetler bu sayaca dahil edilmez.</small>'}<small>Bu sayaç uygulamanın başarılı özet isteklerinden gelir; sağlayıcının fatura ekranı yerine geçmez.</small></section>
      <details class="full"><summary>Gizlilik ve sağlayıcı seçimi</summary><p>Özet oluşturulurken görüşme notları seçtiğiniz yapay zeka sağlayıcısına gönderilir. Ham notlar uygulamada korunur; oluşturulan özet 300 karakterle sınırlıdır.</p><p>Vercel AI Gateway, Vercel dağıtımındaki kimlik doğrulamayla çalışır. OpenAI API seçildiğinde kendi OpenAI anahtarınız şifreli saklanır. API anahtarları hiçbir kullanıcıya veya tarayıcıya geri gönderilmez.</p></details></div><div class="actions"><button class="primary" type="submit">Yapay Zeka Ayarlarını Kaydet</button></div></form>
  </section>`;
  bindSettingsSectionTabs();
  const form = $('#aiConfigForm');
  const updateModel = () => {
    const custom = form.elements.modelPreset.value === '__custom';
    $('#aiCustomModelField').hidden = !custom;
    form.elements.model.required = custom;
    if (!custom) form.elements.model.value = form.elements.modelPreset.value;
  };
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
  form.elements.modelPreset.onchange = updateModel;
  form.elements.provider.onchange = updateProvider;
  updateModel();
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

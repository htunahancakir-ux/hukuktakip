function aiSettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('Yapay zeka ayarlarını yalnızca CEO yönetebilir.');
  let config;
  try {
    config = authApi('/api/ai/config');
  } catch (error) {
    return toast(error.message);
  }
  const models = Array.isArray(config.modelOptions) ? config.modelOptions : [];
  const customProviders = Array.isArray(config.customProviders) ? config.customProviders : [];
  const activeCustom = customProviders.find((item) => config.provider === 'custom:' + item.id);
  const gateway = config.provider === 'vercel-ai-gateway';
  const knownModel = !activeCustom && models.some((model) => model.id === config.model);
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
  const providerOptions = `<option value="vercel-ai-gateway" ${gateway ? 'selected' : ''}>Vercel AI Gateway</option><option value="openai" ${config.provider === 'openai' ? 'selected' : ''}>OpenAI API</option>${customProviders.map((item) => `<option value="custom:${esc(item.id)}" ${activeCustom?.id === item.id ? 'selected' : ''}>${esc(item.name)} — özel sağlayıcı</option>`).join('')}<option value="custom:new">＋ Yeni sağlayıcı ek…</option>`;
  const effortOptions = [
    ['none', 'Varsayılan / kapalı'],
    ['low', 'Düşük'],
    ['medium', 'Orta'],
    ['high', 'Yüksek'],
    ['xhigh', 'Çok yüksek'],
  ]
    .map(
      ([id, label]) =>
        `<option value="${id}" ${config.reasoningEffort === id ? 'selected' : ''}>${label}</option>`,
    )
    .join('');
  $('#content').innerHTML = `${settingsSectionTabs('ai')}<section class="panel">
    <div class="panelhead"><div><h2>Yapay Zeka</h2><p>Görüşmelerin otomatik özetini oluşturacak sağlayıcıyı seçin.</p></div><span class="badge">${config.enabled ? 'Etkin' : 'Kapalı'}</span></div>
    <form id="aiConfigForm"><div class="formbody grid">
      <label class="settings-check full"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}> Otomatik görüşme özetlerini aç</label>
      <label class="field">Sağlayıcı<select name="provider">${providerOptions}</select><small>Vercel AI Gateway, tek kimlik doğrulamayla farklı model sağlayıcılarını kullanır. Özel sağlayıcılar kendi Base URL ve anahtarlarıyla çalışır.</small></label>
      <div class="field"><span class="field-label">Özel sağlayıcı</span><button class="secondary" type="button" id="aiAddProvider">＋ Yeni Sağlayıcı Ekle</button><small>Özel sağlayıcı kaydı eklemek için seçin; en fazla 12 kayıt saklanır.</small></div>
      <section class="full grid" id="aiCustomProviderFields" ${activeCustom ? '' : 'hidden'}>
        <label class="field">Sağlayıcı adı<input name="providerName" maxlength="80" value="${esc(activeCustom?.name || '')}" placeholder="ör. OpenRouter"></label>
        <label class="field">API biçimi<select name="apiFormat"><option value="responses" ${activeCustom?.apiFormat === 'responses' ? 'selected' : ''}>Responses API</option><option value="chat-completions" ${activeCustom?.apiFormat === 'chat-completions' ? 'selected' : ''}>Chat Completions API</option></select><small>Sağlayıcınızın API dokümanındaki OpenAI uyumlu biçimi seçin.</small></label>
        <label class="field full">Base URL<input name="baseUrl" type="url" maxlength="300" value="${esc(activeCustom?.baseUrl || '')}" placeholder="https://api.ornek.com/v1"><small>HTTPS, genel erişimli alan adı ve sürüm yolu girin; uygulama seçilen API yolunu otomatik ekler.</small></label>
        <div class="field full"><button class="secondary" type="button" id="aiLoadModels">Modelleri getir</button><small>Base URL ve API anahtarı girilince model listesi kendiliğinden yüklenir. Sağlayıcı listeyi vermezse model adını elle yazın.</small></div>
      </section>
      <label class="field" id="aiModelPresetField">Dil modeli (ucuzdan pahalıya)<select name="modelPreset">${modelOptions}<option value="__custom" ${knownModel ? '' : 'selected'}>Özel model adı gir…</option></select><small>Fiyatlar USD / 1 milyon token; girdi ve çıktı ayrı ücretlenir.</small></label>
      <label class="field" id="aiCustomModelField" ${knownModel ? 'hidden' : ''}>Model<input name="model" required maxlength="128" list="aiModelList" autocomplete="off" value="${esc(config.model)}" placeholder="ör. anthropic/claude-sonnet-4"><datalist id="aiModelList"></datalist><small id="aiModelStatus" role="status" aria-live="polite">Özel sağlayıcının tam model kimliğini girin.</small></label>
      <label class="field">Reasoning effort<select name="reasoningEffort">${effortOptions}</select><small>Sağlayıcı destekliyorsa modelin düşünme düzeyini belirler; desteklemeyen modelde Varsayılanı seçin.</small></label>
      <label class="field">Özet uzunluğu (karakter)<input name="summaryMaxChars" type="number" required min="100" max="2000" step="1" value="${config.summaryMaxChars}"><small>100–2.000 karakter. Bu ayarı değiştirince özetler yeni uzunlukla yeniden oluşturulur.</small></label>
      <label class="field full" id="aiApiKeyField" ${gateway ? 'hidden' : ''}>API anahtarı<input name="apiKey" type="password" maxlength="512" autocomplete="new-password" data-optional="true" placeholder="${config.apiKeySaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'API anahtarını girin'}"><small>Anahtar yalnızca bu istek sırasında sunucuya gider; şifrelenerek saklanır ve tekrar görüntülenmez.</small></label>
      <label class="settings-check full" id="aiClearKeyField" ${!config.apiKeySaved || gateway ? 'hidden' : ''}><input type="checkbox" name="clearApiKey"> Kayıtlı API anahtarını sil</label>
      <div class="full" id="aiDeleteProviderAction" ${activeCustom ? '' : 'hidden'}><button class="secondary" type="button" id="aiDeleteProvider">Bu özel sağlayıcıyı sil</button></div>
      <div class="notice full" id="aiProviderNotice"></div>
      <div class="full"><button class="secondary" type="button" id="aiTestConnection">Seçili Model ve Anahtarı Test Et</button><small id="aiTestStatus" role="alert" aria-live="polite">Test yalnızca kısa bir “OK” isteği gönderir. Girilen anahtar test edilse bile kaydedilmez.</small></div>
      <section class="notice full" aria-label="AI kullanım istatistikleri"><strong>API kullanımı</strong><p><b>${tokens(usage.totalTokens)}</b> toplam token · ${tokens(usage.inputTokens)} girdi · ${tokens(usage.outputTokens)} çıktı · ${tokens(usage.requests)} başarılı AI isteği${usage.lastUsedAt ? ` · son kullanım: ${esc(new Date(usage.lastUsedAt).toLocaleString('tr-TR'))}` : ''}</p>${(usage.models || []).length ? `<small>${usage.models.map((row) => `${esc(row.model)}: ${tokens(row.totalTokens)} token (${tokens(row.requests)} istek)`).join(' · ')}</small>` : '<small>Henüz sağlayıcı tarafından token kullanımı döndürülmedi. Yerel yedek özetler bu sayaca dahil edilmez.</small>'}<small>Bu sayaç uygulamanın başarılı özet isteklerinden gelir; sağlayıcının fatura ekranı yerine geçmez.</small></section>
      <details class="full"><summary>Gizlilik ve sağlayıcı seçimi</summary><p>Özet oluşturulurken görüşme notları seçtiğiniz yapay zeka sağlayıcısına gönderilir. Ham notlar uygulamada korunur.</p><p>API anahtarları hiçbir kullanıcıya veya tarayıcıya geri gönderilmez. Özel sağlayıcılarda yalnızca HTTPS Base URL kabul edilir; yerel ağ ve IP adresleri engellenir.</p></details></div><div class="actions"><button class="primary" type="submit">Yapay Zeka Ayarlarını Kaydet</button></div></form>
  </section>`;
  bindSettingsSectionTabs();
  const form = $('#aiConfigForm');
  form
    .querySelector('.grid')
    .insertAdjacentHTML(
      'beforeend',
      `<div class="full"><h3>Ses kayıtlarını yazıya çevirme</h3></div><label class="settings-check"><input type="checkbox" name="transcriptionEnabled" ${config.transcriptionEnabled !== false ? 'checked' : ''}> Yazıya çevirmeyi etkinleştir</label><label class="field">Ses çözümleme modeli<input data-optional="true" name="transcriptionModel" list="aiModelList" autocomplete="off" value="${esc(config.transcriptionModel || 'openai/gpt-transcribe')}" maxlength="128"><small>Yukarıdaki sağlayıcı ve kimlik bilgileri kullanılır. Bu alan özet modelinden ayrıdır. Gateway için sağlayıcı/model, OpenAI için model adı kullanılır; özel sağlayıcı /audio/transcriptions desteği sunmalıdır. İşlemler Görüşme Kayıtları ekranından başlatılır.</small></label>`,
    );
  const setCustomValues = (provider) => {
    form.elements.providerName.value = provider?.name || '';
    form.elements.baseUrl.value = provider?.baseUrl || '';
    form.elements.apiFormat.value = provider?.apiFormat || 'responses';
    form.elements.model.value = provider?.model || '';
    form.elements.reasoningEffort.value = provider?.reasoningEffort || 'none';
    form.elements.modelPreset.value = '__custom';
  };
  const updateModel = () => {
    const custom = String(form.elements.provider.value).startsWith('custom:');
    const manual = custom || form.elements.modelPreset.value === '__custom';
    $('#aiModelPresetField').hidden = custom;
    $('#aiCustomModelField').hidden = !manual;
    form.elements.model.required = manual;
    if (!manual) form.elements.model.value = form.elements.modelPreset.value;
  };
  // A custom provider's model names are listed from its own /models endpoint once the address (and,
  // where the provider wants one, the key) is typed. Typing stays free: a name that is not listed works.
  const modelList = $('#aiModelList');
  const modelStatus = $('#aiModelStatus');
  const modelHint = modelStatus.textContent;
  const loadButton = $('#aiLoadModels');
  let modelTimer;
  let modelRequest = 0;
  let modelController;
  const loadModels = async ({ auto = false } = {}) => {
    clearTimeout(modelTimer);
    modelController?.abort();
    const id = ++modelRequest;
    const source = {
      provider: String(form.elements.provider.value),
      baseUrl: form.elements.baseUrl.value.trim(),
      apiKey: form.elements.apiKey.value.trim(),
    };
    const custom = source.provider.startsWith('custom:');
    const ready =
      custom && /^https:\/\/[^/\s]+\.[^/\s]+/iu.test(source.baseUrl) && form.elements.baseUrl.validity.valid;
    if (!ready) {
      modelList.replaceChildren();
      modelStatus.textContent = custom && !auto ? 'Önce geçerli bir HTTPS Base URL girin.' : modelHint;
      loadButton.disabled = false;
      return;
    }
    modelController = new AbortController();
    modelStatus.textContent = 'Modeller yükleniyor…';
    loadButton.disabled = true;
    try {
      const response = await fetch('/api/ai/models', {
        method: 'POST',
        credentials: 'same-origin',
        signal: modelController.signal,
        headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
        body: JSON.stringify(source),
      });
      const result = await response.json().catch(() => ({}));
      if (id !== modelRequest) return;
      if (!response.ok) throw Error(result.error || 'Model listesi alınamadı.');
      modelList.replaceChildren(
        ...result.models.map((model) => Object.assign(document.createElement('option'), { value: model.id })),
      );
      modelStatus.textContent = result.models.length
        ? `${result.models.length} model bulundu${result.truncated ? ` (toplam ${result.total}; ilk ${result.models.length} gösteriliyor)` : ''}. Listeden seçin veya adı elle yazın.`
        : 'Sağlayıcı boş bir model listesi döndürdü. Model adını elle yazın.';
    } catch (error) {
      if (id !== modelRequest || error.name === 'AbortError') return;
      modelList.replaceChildren();
      modelStatus.textContent = `${error.message} Model adını elle de yazabilirsiniz.`;
    } finally {
      if (id === modelRequest) loadButton.disabled = false;
    }
  };
  const scheduleModels = () => {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(() => loadModels({ auto: true }), 800);
  };
  const updateProvider = () => {
    const selected = form.elements.provider.value;
    const selectedCustom = customProviders.find((item) => selected === 'custom:' + item.id);
    if (selected === 'custom:new') setCustomValues();
    else if (selectedCustom) setCustomValues(selectedCustom);
    const custom = selected.startsWith('custom:');
    const usingGateway = selected === 'vercel-ai-gateway';
    $('#aiCustomProviderFields').hidden = !custom;
    $('#aiApiKeyField').hidden = usingGateway;
    $('#aiClearKeyField').hidden =
      usingGateway || !(selectedCustom?.apiKeySaved || (selected === config.provider && config.apiKeySaved));
    $('#aiDeleteProviderAction').hidden = !selectedCustom;
    $('#aiProviderNotice').textContent = usingGateway
      ? 'Vercel AI Gateway seçili. Model alanında desteklenen sağlayıcı/model adını kullanabilirsiniz; bu seçenek için uygulamaya ayrı API anahtarı girilmez.'
      : !config.encryptionReady
        ? 'Anahtar saklama şifrelemesi Vercel ortamında hazır değil. Önce AI_ENCRYPTION_KEY gizli değişkenini tanımlayın.'
        : custom
          ? 'Özel sağlayıcı anahtarı AES-256-GCM ile şifrelenerek saklanır. Base URL yalnızca genel HTTPS uç noktası olabilir.'
          : 'OpenAI anahtarı AES-256-GCM ile şifrelenerek saklanır. Kayıtlı anahtar gösterilmez.';
    updateModel();
  };
  form.elements.modelPreset.onchange = updateModel;
  form.elements.provider.onchange = updateProvider;
  form.elements.provider.addEventListener('change', scheduleModels);
  form.elements.baseUrl.addEventListener('input', scheduleModels);
  form.elements.apiKey.addEventListener('input', scheduleModels);
  loadButton.onclick = () => loadModels();
  $('#aiAddProvider').onclick = () => {
    form.elements.provider.value = 'custom:new';
    updateProvider();
    form.elements.providerName.focus();
  };
  updateProvider();
  // A saved provider already has its key: list its models when the page opens.
  if (activeCustom?.apiKeySaved) loadModels({ auto: true });
  const readInput = () => {
    const input = Object.fromEntries(new FormData(form));
    input.enabled = form.elements.enabled.checked;
    input.transcriptionEnabled = form.elements.transcriptionEnabled.checked;
    input.clearApiKey = form.elements.clearApiKey?.checked === true;
    input.provider = String(input.provider || '').trim();
    input.model = String(input.model || '').trim();
    input.apiKey = String(input.apiKey || '').trim();
    return input;
  };
  $('#aiTestConnection').onclick = () => {
    const button = $('#aiTestConnection');
    const status = $('#aiTestStatus');
    button.disabled = true;
    status.textContent = 'Bağlantı test ediliyor…';
    try {
      const result = authApi('/api/ai/test', 'POST', readInput());
      status.textContent = `✓ Bağlantı başarılı: ${result.model} · ${tokens(result.usage?.totalTokens)} token kullanıldı. Ayarları kalıcı yapmak için Kaydet’e basın.`;
    } catch (error) {
      status.textContent = '✕ ' + error.message;
    } finally {
      button.disabled = false;
    }
  };
  $('#aiDeleteProvider').onclick = () => {
    if (!window.confirm('Bu özel sağlayıcıyı ve şifrelenmiş API anahtarını silmek istiyor musunuz?')) return;
    try {
      const input = readInput();
      input.deleteCustomProvider = true;
      authApi('/api/ai/config', 'PUT', input);
      aiSettingsPage();
      toast('Özel sağlayıcı silindi.');
    } catch (error) {
      toast(error.message);
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    try {
      authApi('/api/ai/config', 'PUT', readInput());
      aiSettingsPage();
      toast('Yapay zeka ayarları kaydedildi. Yeni görüşme özetleri bu bağlantıyı kullanacak.');
    } catch (error) {
      toast(error.message);
    }
  };
}

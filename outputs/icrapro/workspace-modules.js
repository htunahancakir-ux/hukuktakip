// Settings → Modüller: what the office owns and what it can ask the sales team to add.
// Requests are only a lead for the sales team; nothing is bought or billed from here.
// Prices are shown without VAT (KDV hariç). Server text is always escaped.
const MODULE_STATUS = { active: 'Aktif', trial: 'Deneme', past_due: 'Ödeme bekleniyor', suspended: 'Askıda' };
const MODULE_REQUESTED_TEXT = 'Talep edildi — satış ekibimiz sizi arayacak';

function moduleOwnedStatus(item) {
  if (item.status === 'trial')
    return item.trialUntil ? `Deneme · ${catalogUntil(item.trialUntil)}` : 'Deneme';
  return MODULE_STATUS[item.status] || String(item.status || '');
}

function moduleProductCard(product) {
  const price = catalogPriceText(product);
  const campaign = catalogCampaignText(product.campaign);
  const features = (product.features || []).map((feature) => `<li>${esc(feature)}</li>`).join('');
  const trial = product.trialUntil
    ? `Deneme · ${catalogUntil(product.trialUntil)}`
    : product.trialDays > 0
      ? `${product.trialDays} gün ücretsiz deneme`
      : '';
  return `<article class="module-card" data-module-code="${esc(product.code)}">
    <div class="module-card-head"><h3>${esc(product.name)}</h3>${product.status === 'soon' ? '<span class="badge module-soon">Yakında</span>' : ''}</div>
    ${product.description ? `<p class="module-desc">${esc(product.description)}</p>` : ''}
    ${features ? `<ul class="module-features">${features}</ul>` : ''}
    ${price ? `<p class="module-price"><strong>${esc(price)}</strong></p>` : ''}
    ${trial ? `<p class="module-trial">${esc(trial)}</p>` : ''}
    ${campaign ? `<p class="module-campaign">${product.campaign.name ? `<strong>${esc(product.campaign.name)}</strong> · ` : ''}${esc(campaign)}${product.campaign.couponCode ? ` · Kupon kodu: <code>${esc(product.campaign.couponCode)}</code>` : ''}</p>` : ''}
    <div class="module-actions">${
      product.requested
        ? `<span class="module-requested" role="status">${MODULE_REQUESTED_TEXT}</span>`
        : '<button type="button" class="primary" data-module-request>Talep et</button>'
    }</div>
  </article>`;
}

function modulesSettingsPage() {
  if (!['ceo', 'admin'].includes(hanAuth?.role))
    return toast('Modül bilgilerini yalnızca yöneticiler görür.');
  let data;
  try {
    data = authApi('/api/office-modules');
  } catch (error) {
    return toast(error.message);
  }
  if (data.legacy) {
    $('#content').innerHTML = `${settingsSectionTabs('modules')}<section class="panel">
      <div class="panelhead"><div><h2>Modüller</h2></div></div>
      <div class="notice" id="modulesLegacy">Büronuzun modülleri platform tarafından yönetilir; bu hesap için satın alınabilir bir modül kataloğu bulunmuyor.</div>
    </section>`;
    bindSettingsSectionTabs();
    return;
  }
  const subscription = data.subscription;
  const owned = data.owned || [];
  // A module on free trial stays buyable (the server lists it with trialUntil); only an
  // active one is hidden. Usage packs and services can be bought again and again.
  const ownedCodes = new Set(owned.filter((item) => item.status === 'active').map((item) => item.code));
  const products = (data.products || []).filter((product) => !ownedCodes.has(product.code));
  const productByCode = new Map(products.map((product) => [product.code, product]));
  $('#content').innerHTML = `${settingsSectionTabs('modules')}
    <section class="panel" id="modulesSubscription">
      <div class="panelhead"><div><h2>Aboneliğiniz</h2></div></div>
      <div class="formbody">${
        subscription
          ? `<div class="stats"><div class="stat"><div><small>Kullanıcı</small><strong>${esc(subscription.used)} / ${esc(subscription.seatLimit)}</strong></div></div><div class="stat"><div><small>Bitiş tarihi</small><strong>${esc(subscription.accessUntil ? catalogDate(subscription.accessUntil) : '—')}</strong></div></div></div>`
          : '<p>Abonelik bilgisi bulunamadı.</p>'
      }</div>
    </section>
    <section class="panel" id="modulesOwned" style="margin-top:18px">
      <div class="panelhead"><div><h2>Büronuzdaki modüller</h2></div></div>
      <div class="tablewrap"><table><thead><tr><th>Modül</th><th>Durum</th><th>Fiyat</th></tr></thead><tbody>${
        owned
          .map(
            (item) =>
              `<tr><td>${esc(item.name)}</td><td>${esc(moduleOwnedStatus(item))}</td><td>${esc(catalogPriceText(item) || '—')}</td></tr>`,
          )
          .join('') || '<tr><td colspan="3" class="empty">Henüz ek modülünüz yok.</td></tr>'
      }</tbody></table></div>
    </section>
    <section class="panel" id="modulesAvailable" style="margin-top:18px">
      <div class="panelhead"><div><h2>Satın alabilecekleriniz</h2><p>Fiyatlar KDV hariçtir. Talebiniz satış ekibimize iletilir; ödeme bu ekrandan alınmaz.</p></div></div>
      <div class="formbody"><div class="module-grid">${
        products.map(moduleProductCard).join('') || '<p class="empty">Şu anda sunulan ek modül yok.</p>'
      }</div></div>
    </section>`;
  bindSettingsSectionTabs();
  document.querySelectorAll('[data-module-request]').forEach((button) => {
    const card = button.closest('[data-module-code]');
    button.onclick = () => moduleRequestDialog(productByCode.get(card.dataset.moduleCode), card);
  });
}

function moduleRequestDialog(product, card) {
  if (!product) return;
  let dialog = document.getElementById('moduleRequestDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'moduleRequestDialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form id="moduleRequestForm"><div class="panelhead"><h2></h2><button type="button" class="secondary" data-module-close>Kapat</button></div>
    <div class="formbody grid">
      <p class="full">Satış ekibimiz sizi arayarak kurulumu ve ücretlendirmeyi netleştirecek.</p>
      <label class="field full">Notunuz (isteğe bağlı)<textarea name="note" maxlength="500" rows="3" placeholder="Örn. hangi gün ve saatte aranmak istersiniz?"></textarea></label>
      <p class="formerror full" role="alert" id="moduleRequestError"></p>
    </div><div class="actions"><button type="submit" class="primary">Talep et</button></div></form>`;
  dialog.querySelector('h2').textContent = product.name;
  dialog.querySelector('[data-module-close]').onclick = () => dialog.close();
  const form = dialog.querySelector('#moduleRequestForm');
  form.onsubmit = (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    const note = form.elements.note.value.trim();
    try {
      authApi(
        '/api/office-modules/request',
        'POST',
        note ? { code: product.code, note } : { code: product.code },
      );
      product.requested = true;
      const actions = card.querySelector('.module-actions');
      actions.textContent = '';
      const done = document.createElement('span');
      done.className = 'module-requested';
      done.setAttribute('role', 'status');
      done.textContent = MODULE_REQUESTED_TEXT;
      actions.append(done);
      dialog.close();
      toast('Talebiniz alındı.');
    } catch (error) {
      dialog.querySelector('#moduleRequestError').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  if (!dialog.open) dialog.showModal();
}

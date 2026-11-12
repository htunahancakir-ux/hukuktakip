// Home page: one announcement card from the platform (new product, campaign, price change or
// planned maintenance). Managers may see product and campaign details; staff only ever get
// maintenance notices. Everything the platform wrote is escaped; a failing request is skipped
// silently so the home page never breaks because of an announcement.
const NEWS_KIND_LABEL = {
  new_product: 'Yeni',
  campaign: 'Kampanya',
  price_change: 'Fiyat değişikliği',
  maintenance: 'Planlı bakım',
};
const TR_MONTHS = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
];

// Integer kuruş → "₺1.250" / "₺99,90".
function catalogMoney(kurus) {
  const value = Number(kurus);
  if (!Number.isFinite(value)) return '';
  return (
    '₺' +
    new Intl.NumberFormat('tr-TR', {
      minimumFractionDigits: value % 100 ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(value / 100)
  );
}

// "2026-11-30" or an ISO timestamp → { day, month (0-11), year } in Istanbul time.
function catalogDateParts(value) {
  const text = String(value ?? '');
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (plain) return { year: +plain[1], month: +plain[2] - 1, day: +plain[3] };
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Istanbul',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { year: +parts.year, month: +parts.month - 1, day: +parts.day };
}

// "30 Kasım" (the year is added when it is not the current one).
function catalogDate(value) {
  const parts = catalogDateParts(value);
  if (!parts) return '';
  const year = parts.year === new Date().getFullYear() ? '' : ' ' + parts.year;
  return `${parts.day} ${TR_MONTHS[parts.month]}${year}`;
}

// "30 Kasım'a kadar": only Eylül and Ekim take the front-vowel suffix. Dates in another
// year get the year and "tarihine kadar" instead of a suffix.
function catalogUntil(value) {
  const parts = catalogDateParts(value);
  if (!parts) return '';
  const label = catalogDate(value);
  if (/\d{4}$/.test(label)) return `${label} tarihine kadar`;
  return `${label}'${[8, 9].includes(parts.month) ? 'e' : 'a'} kadar`;
}

function catalogPriceText(product) {
  if (!product || product.priceKurus === null || product.priceKurus === undefined) return '';
  const price = catalogMoney(product.priceKurus);
  if (!price) return '';
  if (product.kind === 'usage_pack') {
    const size = [product.packQuantity, product.packUnit].filter(Boolean).join(' ');
    return `${price} / paket${size ? ` (${size})` : ''} · KDV hariç`;
  }
  if (product.kind === 'service') return `${price} (tek seferlik) · KDV hariç`;
  return `${price} / ay · KDV hariç`;
}

function catalogCampaignText(campaign) {
  if (!campaign) return '';
  const term =
    { first_month: 'İlk ay', first_3_months: 'İlk 3 ay', whole_term: 'Abonelik boyunca' }[campaign.applies] ||
    '';
  const discount =
    campaign.discountType === 'amount'
      ? `ayda ${catalogMoney(campaign.discountValue)} indirim`
      : `%${campaign.discountValue} indirim`;
  const until = campaign.endsAt ? catalogUntil(campaign.endsAt) : '';
  return [[term, discount].filter(Boolean).join(' '), until].filter(Boolean).join(' · ');
}

function platformNewsOffer(card) {
  const lines = [];
  const product = card.product;
  if (product) {
    const price = catalogPriceText(product);
    lines.push(
      `<p class="news-product"><strong>${esc(product.name)}</strong>${price ? ` · ${esc(price)}` : ''}${product.available === false ? ' · <em>Yakında</em>' : ''}</p>`,
    );
  }
  const campaignText = catalogCampaignText(card.campaign);
  if (campaignText) {
    lines.push(
      `<p class="news-campaign">${card.campaign.name ? `<strong>${esc(card.campaign.name)}</strong> · ` : ''}${esc(campaignText)}</p>`,
    );
  }
  if (card.campaign?.couponCode)
    lines.push(`<p class="news-coupon">Kupon kodu: <code>${esc(card.campaign.couponCode)}</code></p>`);
  if (card.endsAt && !card.campaign?.endsAt)
    lines.push(`<p class="news-until">${esc(catalogUntil(card.endsAt))}</p>`);
  return lines.join('');
}

function platformNewsInterestDone(host) {
  const actions = host.querySelector('.news-actions');
  if (!actions) return;
  actions.querySelector('[data-news-interest]')?.remove();
  if (!actions.querySelector('.news-thanks')) {
    const thanks = document.createElement('span');
    thanks.className = 'news-thanks';
    thanks.setAttribute('role', 'status');
    thanks.textContent = 'Talebiniz alındı, sizi arayacağız.';
    actions.prepend(thanks);
  }
}

function renderPlatformNewsCard(card) {
  const isManager = ['ceo', 'admin'].includes(hanAuth?.role);
  const host = document.createElement('section');
  host.id = 'platformNewsHome';
  host.className = `panel news-card news-${String(card.kind).replace(/[^a-z_]/g, '')}`;
  host.dataset.newsId = card.id;
  const canInterest =
    isManager && card.product && card.product.owned !== 'active' && card.product.available !== false;
  const owned = card.product?.owned === 'active';
  host.innerHTML = `<div class="news-head"><span class="news-kind">${esc(NEWS_KIND_LABEL[card.kind] || '')}</span><h3 class="news-title">${esc(card.title)}</h3></div>
    ${card.body ? `<p class="news-body">${esc(card.body)}</p>` : ''}
    ${isManager ? platformNewsOffer(card) : card.endsAt ? `<p class="news-until">${esc(catalogUntil(card.endsAt))}</p>` : ''}
    <div class="news-actions">
      ${isManager ? '<button type="button" class="secondary" data-news-open>İncele</button>' : ''}
      ${canInterest ? '<button type="button" class="primary" data-news-interest>İlgileniyorum</button>' : ''}
      ${owned ? '<span class="news-thanks">Bu modül büronuzda aktif.</span>' : ''}
      ${card.dismissible ? '<button type="button" class="link" data-news-dismiss>Kapat</button>' : ''}
    </div>`;
  const base = '/api/platform-news/' + encodeURIComponent(card.id);
  const open = host.querySelector('[data-news-open]');
  if (open)
    open.onclick = () => {
      try {
        authApi(base + '/click', 'POST', {});
      } catch {
        // The click count is best-effort; opening the catalog must still work.
      }
      settingsTab = 'modules';
      page = 'settings';
      render();
    };
  const interest = host.querySelector('[data-news-interest]');
  if (interest)
    interest.onclick = () => {
      interest.disabled = true;
      try {
        authApi(base + '/interest', 'POST', {});
        platformNewsInterestDone(host);
      } catch (error) {
        interest.disabled = false;
        toast(error.message);
      }
    };
  const dismiss = host.querySelector('[data-news-dismiss]');
  if (dismiss)
    dismiss.onclick = () => {
      try {
        authApi(base + '/dismiss', 'POST', {});
        host.remove();
      } catch (error) {
        toast(error.message);
      }
    };
  if (card.interested) platformNewsInterestDone(host);
  return host;
}

function loadPlatformNewsHome() {
  if (typeof page === 'undefined' || page !== 'home') return;
  if (globalThis.hanModules?.catalog !== true || !window.hanAuth) return;
  const content = document.getElementById('content');
  if (!content || document.getElementById('platformNewsHome')) return;
  let result;
  try {
    result = authApi('/api/platform-news');
  } catch {
    return;
  }
  const card = result?.card;
  if (!card || !card.id || !card.title) return;
  content.prepend(renderPlatformNewsCard(card));
}

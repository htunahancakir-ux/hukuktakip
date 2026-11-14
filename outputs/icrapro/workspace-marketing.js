// Pazarlama → Rota Bulma: Google Maps firm search, a map to draw the search region on,
// filters, route links, WhatsApp hand-off and visit records. Pure route logic lives in
// workspace-marketing-route.js, the map in workspace-marketing-map.js.
let marketingView = 'prospects';
const MARKETING_FILTER_DEFAULTS = Object.freeze({
  phone: '',
  visit: 'all',
  hideRefused: true,
  maxKm: 0,
  openNow: false,
  districtOnly: true,
  hideClosed: true,
  minRating: 0,
  minReviews: 0,
  website: '',
  district: '',
  exclude: '',
  query: '',
  sort: '',
});
const marketingRouteState = {
  tab: 'search',
  overview: null,
  overviewStale: false,
  form: {
    source: '',
    depth: 'normal',
    sector: '',
    sectors: [],
    customQuery: '',
    city: '',
    district: '',
    neighborhood: '',
    avenue: '',
    street: '',
  },
  criteria: null,
  // The region drawn on the map, as [lat, lng] corners. It limits the next search and
  // narrows the firms already found.
  region: null,
  // The map on screen (workspace-marketing-map.js) and where it was looking, so a redraw
  // of the page returns to the same place.
  map: null,
  mapView: null,
  mapMount: null,
  // Source of the current result list: 'google', 'platform' (the subscription) or 'scraper'.
  source: 'google',
  // A running scrape: { jobId, criteria, depth, startedAt }. Polling resumes when the page reopens.
  job: null,
  pollTimer: null,
  places: [],
  nextPageToken: '',
  outside: 0,
  loading: false,
  selected: new Set(),
  filters: { ...MARKETING_FILTER_DEFAULTS },
  // Device coordinates stay in this page's memory; only the start's label is saved.
  origin: { mode: 'none', label: '', lat: null, lng: null },
  plan: null,
  saved: null,
  savedPerLink: 10,
};

const marketingDate = (value) =>
  /^\d{4}-\d{2}-\d{2}/.test(value || '')
    ? value.slice(8, 10) + '.' + value.slice(5, 7) + '.' + value.slice(0, 4)
    : '';
const marketingKm = (meters) =>
  meters < 1000
    ? Math.round(meters) + ' m'
    : (meters / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' km';
const marketingRequestId = () =>
  globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
// Only web links: never javascript:, data: or other schemes from third-party data.
const marketingSafeUrl = (value) => (/^https?:\/\//i.test(value || '') ? value : '');
// Same rule as authApi and the server: read-only applies to everyone except the CEO.
const marketingReadOnly = () => hanAuth?.readOnly === true && hanAuth.role !== 'ceo';

async function marketingRouteRequest(url, data) {
  if (marketingReadOnly()) throw Error('Bu hesap salt okunurdur. Google Haritalar araması yapılamaz.');
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    throw Error('Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.');
  }
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (response.status === 401) {
    location.reload();
    throw Error('Oturum sona erdi. Yeniden giriş yapın.');
  }
  if (
    response.status === 423 &&
    result.code === 'staff_on_break' &&
    typeof applyStaffBreakStatus === 'function'
  )
    applyStaffBreakStatus(result.activeBreak);
  if (!response.ok) throw Error(result.error || 'İşlem yapılamadı.');
  return result;
}

function openMarketingRouteFinder() {
  marketingRouteState.overview = null;
  marketingRoutePage();
}

function marketingRoutePage() {
  const state = marketingRouteState;
  marketingView = 'routes';
  if (!state.overview || state.overviewStale) {
    try {
      state.overview = authApi('/api/marketing/overview');
      state.overviewStale = false;
    } catch (error) {
      marketingView = 'prospects';
      return toast(error.message);
    }
  }
  const tabs = [
    ['search', 'Firma Bul ve Rota Oluştur'],
    ['saved', 'Rotalarım (' + state.overview.routes.length + ')'],
  ];
  $('#content').innerHTML = `<section class="panel marketing-route">
    <div class="panelhead"><div><h2>Rota Bulma</h2><p>Google Haritalar’daki firmaları bulun, süzün ve ziyaret rotası oluşturun.</p></div>
      <div class="toolbar"><button type="button" class="secondary" id="marketingRouteBack">← Pazarlama</button></div></div>
    <div class="formbody"><div class="settings-tabs" role="tablist" aria-label="Rota Bulma">${tabs
      .map(
        ([key, label]) =>
          `<button type="button" role="tab" aria-selected="${state.tab === key}" class="${state.tab === key ? 'selected' : ''}" data-marketing-tab="${key}">${esc(label)}</button>`,
      )
      .join('')}</div></div>
    <div id="marketingRouteBody"></div>
  </section>`;
  $('#marketingRouteBack').onclick = () => {
    marketingView = 'prospects';
    render();
  };
  document.querySelectorAll('[data-marketing-tab]').forEach(
    (button) =>
      (button.onclick = () => {
        state.tab = button.dataset.marketingTab;
        if (state.tab === 'saved') state.saved = null;
        marketingRoutePage();
      }),
  );
  if (state.tab === 'saved') marketingSavedRoutes();
  else marketingSearchTab();
}

function marketingSources() {
  const overview = marketingRouteState.overview;
  // Older servers sent only `ready` for Google.
  return (overview.sources || [{ id: 'google', label: 'Google Places API', ready: overview.ready }]).filter(
    (source) => source.ready,
  );
}

function marketingBlockedNotice() {
  const overview = marketingRouteState.overview;
  if (!marketingSources().length) {
    // A subscribed office has nothing to set up: its service is off or this month's
    // searches are used up.
    if (overview.service?.message) return esc(overview.service.message);
    return overview.canConfigure
      ? 'Firma arama kaynağı kurulmadı. Ayarlar → Entegrasyonlar → Google Haritalar bölümünden Google API anahtarını veya harita tarama sunucusunu girin. <button type="button" class="link" id="marketingOpenSettings">Ayarlara git</button>'
      : 'Firma arama kaynağı kurulmadı. CEO’nun Ayarlar → Entegrasyonlar → Google Haritalar bölümünden bir kaynak bağlaması gerekiyor.';
  }
  if (marketingReadOnly()) return 'Bu hesap salt okunurdur. Harita araması yapılamaz.';
  return '';
}

const marketingSourceLabel = (source) =>
  ({ scraper: 'Harita tarama (gosom)', platform: 'Hazır harita servisi' })[source] || 'Google Places API';

// "Kızılay / Çankaya / Ankara", or the drawn region when the search named no place.
function marketingAreaLabel(criteria) {
  const named = [criteria.neighborhood, criteria.district, criteria.city].filter(Boolean).join(' / ');
  if (!named) return 'Haritada çizilen bölge';
  return named + (criteria.region || criteria.drawn ? ' · çizilen bölge' : '');
}

function marketingServiceNote() {
  const service = marketingRouteState.overview.service;
  if (!service || !Number.isFinite(service.searchesLeft)) return '';
  return `Hazır harita servisi: bu ay kalan arama hakkı ${service.searchesLeft.toLocaleString('tr-TR')} / ${Number(
    service.monthlySearches,
  ).toLocaleString('tr-TR')}. Her “Bul” ve “Daha fazla getir” bir arama sayılır.`;
}

// How many searches the office made this month, by source. Shown when the server counts them.
function marketingUsageNote() {
  const usage = marketingRouteState.overview.usage;
  if (!usage) return '';
  const count = (value) => Number(value || 0).toLocaleString('tr-TR');
  const parts = [
    usage.google || marketingSources().some((source) => source.id === 'google')
      ? `Google Places API ${count(usage.google)}`
      : '',
    usage.scraper || marketingSources().some((source) => source.id === 'scraper')
      ? `Harita tarama ${count(usage.scraper)}`
      : '',
    usage.platform || marketingRouteState.overview.service
      ? `Hazır harita servisi ${count(usage.platform)}`
      : '',
  ].filter(Boolean);
  return `Bu ay yapılan arama: ${parts.join(' · ') || '0'}. Her “Bul” ve “Daha fazla getir” bir arama sayılır.`;
}

function marketingShowUsage(usage) {
  if (!usage) return;
  marketingRouteState.overview.usage = usage;
  const note = document.getElementById('marketingUsageNote');
  if (note) note.textContent = marketingUsageNote();
}

function marketingFormSource() {
  const sources = marketingSources().map((source) => source.id);
  const wanted = marketingRouteState.form.source || marketingRouteState.overview.defaultSource;
  return sources.includes(wanted) ? wanted : sources[0] || 'google';
}

function marketingSearchTab() {
  const state = marketingRouteState,
    form = state.form,
    blocked = marketingBlockedNotice(),
    sources = marketingSources(),
    source = marketingFormSource();
  const text = (name, label, placeholder) =>
    `<label class="field">${label}<input name="${name}" maxlength="80" autocomplete="off" data-optional="true" value="${esc(form[name])}" placeholder="${esc(placeholder)}"></label>`;
  const serviceNote = marketingServiceNote();
  const usageNote = marketingUsageNote();
  $('#marketingRouteBody').innerHTML =
    `${blocked ? `<div class="notice marketing-notice">${blocked}</div>` : ''}
    <div class="marketing-search-layout">
    <form id="marketingSearchForm" class="formbody"><div class="grid marketing-search-grid">
      <label class="field">Kaynak<select name="source" ${sources.length > 1 ? '' : 'disabled'}>${(sources.length
        ? sources
        : [{ id: 'google', label: 'Google Places API' }]
      )
        .map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`)
        .join('')}</select></label>
      <label class="field" id="marketingDepthField" title="Tarama birkaç dakika sürer; sonuçlar hazır olunca liste kendiliğinden gelir." ${source === 'scraper' ? '' : 'hidden'}>Tarama kapsamı<select name="depth" data-optional="true"><option value="quick">Hızlı (ilk sonuçlar)</option><option value="normal">Normal</option><option value="wide">Geniş (daha çok firma, daha uzun sürer)</option></select></label>
      <fieldset class="field full marketing-sector-picker"><legend>Sektörler</legend><div class="marketing-sector-options"><label><input type="checkbox" data-marketing-all-sectors data-optional="true"> Hepsi</label>${[...state.overview.sectors, { id: 'custom', label: 'Diğer (elle yazın)' }].map((sector) => `<label><input type="checkbox" name="sector" value="${esc(sector.id)}" data-optional="true"> ${esc(sector.label)}</label>`).join('')}</div><small>Birden fazla sektör seçebilirsiniz. Hepsi seçiliyse tüm firmalar aranır.</small></fieldset>
      <label class="field" id="marketingCustomSector" hidden>Aranacak sektör *<input name="customQuery" maxlength="80" disabled value="${esc(form.customQuery)}" placeholder="ör. elektrik malzemeleri"></label>
      ${clientCityField({ city: form.city, district: form.district }, 'route')}
      ${text('neighborhood', 'Mahalle', 'ör. Kızılay')}${text('avenue', 'Cadde', 'ör. Atatürk Bulvarı')}${text('street', 'Sokak', 'ör. Sakarya Sokak')}
    </div><div class="actions"><button class="primary" type="submit" id="marketingSearchButton" ${blocked ? 'disabled' : ''}>Bul</button><span class="marketing-hint">Yalnızca il seçmek ya da haritada bölge çizmek yeterlidir; diğer alanlar aramayı daraltır.</span></div>${
      serviceNote ? `<p class="marketing-hint" id="marketingServiceNote">${esc(serviceNote)}</p>` : ''
    }${
      usageNote
        ? `<p class="marketing-hint" id="marketingUsageNote" title="Google, Places API’de ayda 1.000 aramayı ücretsiz verir; sonrası ücretlidir.">${esc(usageNote)}</p>`
        : ''
    }</form>
    <section class="marketing-map-panel" aria-label="Harita">
      <div class="marketing-map-tools">
        <button type="button" class="secondary" id="marketingDraw" aria-pressed="false" title="Haritada basılı tutup sürükleyerek aramak istediğiniz bölgenin çevresini çizin">✎ Bölge çiz</button>
        <button type="button" class="secondary" id="marketingViewport" title="Haritada şu an görünen alanı bölge olarak seçer">▭ Görünen alanı seç</button>
        <button type="button" class="secondary" id="marketingRegionClear" title="Çizilen bölgeyi kaldırır">✕ Bölgeyi sil</button>
      </div>
      <p class="marketing-hint marketing-region-status" id="marketingRegionStatus" role="status" aria-live="polite"></p>
      <div id="marketingMap" class="marketing-map"><p class="marketing-map-wait">Harita yükleniyor…</p></div>
      <p class="marketing-hint marketing-map-note" id="marketingMapNote"></p>
    </section>
    </div>
    <div id="marketingResults"></div>
    <div id="marketingPlan"></div>`;
  const searchForm = $('#marketingSearchForm');
  setupClientCity('route');
  setupClientDistrict('route');
  // The application makes every form field mandatory unless it says data-optional
  // (personnel.js). Here only a place is needed: the shared province and district fields
  // are required in client forms, but a province alone or a drawn region alone is enough.
  for (const [name, label] of [
    ['city', 'İl'],
    ['district', 'İlçe'],
  ]) {
    const input = searchForm.elements[name];
    if (!input) continue;
    input.required = false;
    input.dataset.optional = 'true';
    const caption = searchForm.querySelector(`label[for="${input.id}"]`);
    if (caption) caption.textContent = label;
  }
  const checks = [...searchForm.querySelectorAll('[name="sector"]')];
  const all = searchForm.querySelector('[data-marketing-all-sectors]');
  const selectedSectors = form.sectors?.length ? form.sectors : form.sector ? [form.sector] : [];
  for (const input of checks) input.checked = selectedSectors.includes(input.value);
  function syncSectors() {
    const selected = checks.filter((input) => input.checked).map((input) => input.value);
    all.checked = selected.length === 0;
    form.sectors = selected;
    form.sector = selected[0] || '';
    const custom = selected.includes('custom');
    $('#marketingCustomSector').hidden = !custom;
    searchForm.elements.customQuery.disabled = !custom;
  }
  for (const input of checks) input.onchange = syncSectors;
  all.onchange = () => {
    for (const input of checks) input.checked = false;
    syncSectors();
  };
  syncSectors();
  // Choosing a province turns the map to it.
  searchForm.elements.city?.addEventListener('change', () => {
    if (!state.region) state.map?.focusCity(searchForm.elements.city.value);
  });
  $('#marketingDraw').onclick = () => {
    if (!state.map) return toast('Harita henüz yüklenmedi.');
    if (state.map.drawing) state.map.stopDraw();
    else state.map.startDraw();
    marketingRegionStatus();
  };
  $('#marketingViewport').onclick = () => {
    if (!state.map) return toast('Harita henüz yüklenmedi.');
    const region = state.map.viewportRegion();
    if (!region) return toast('Görünen alan bölge olarak seçilemedi. Haritayı biraz yaklaştırın.');
    state.map.stopDraw();
    marketingSetRegion(region);
  };
  $('#marketingRegionClear').onclick = () => {
    state.map?.stopDraw();
    marketingSetRegion(null);
  };
  marketingRegionStatus();
  marketingMountMap();
  searchForm.elements.source.value = source;
  searchForm.elements.depth.value = form.depth;
  searchForm.elements.source.onchange = () => {
    form.source = searchForm.elements.source.value;
    $('#marketingDepthField').hidden = form.source !== 'scraper';
  };
  const settingsLink = document.getElementById('marketingOpenSettings');
  if (settingsLink)
    settingsLink.onclick = () => {
      settingsTab = 'maps';
      page = 'settings';
      marketingView = 'prospects';
      render();
    };
  searchForm.onsubmit = (event) => {
    event.preventDefault();
    const body = marketingSearchInput(searchForm);
    if (!body) return;
    form.source = searchForm.elements.source.value;
    form.depth = searchForm.elements.depth.value;
    if (form.source === 'scraper') marketingStartScrape(body, form.depth);
    else marketingSearch(body, false, form.source === 'platform' ? 'platform' : 'google');
  };
  if (state.job) {
    marketingRenderScrapeStatus();
    marketingScheduleScrapePoll(0);
  } else marketingRenderResults();
  marketingRenderPlan();
}

// --- Map and drawn region -------------------------------------------------------------

const marketingKm2 = (value) =>
  value < 1
    ? Math.round(value * 100) + ' hektar'
    : value.toLocaleString('tr-TR', { maximumFractionDigits: value < 10 ? 1 : 0 }) + ' km²';

function marketingRegionStatus(problem = '') {
  const state = marketingRouteState,
    status = document.getElementById('marketingRegionStatus');
  if (!status) return;
  const drawing = !!state.map?.drawing;
  const draw = document.getElementById('marketingDraw');
  draw.setAttribute('aria-pressed', String(drawing));
  draw.classList.toggle('selected', drawing);
  draw.textContent = drawing ? '✎ Çizimi bırak' : state.region ? '✎ Yeniden çiz' : '✎ Bölge çiz';
  document.getElementById('marketingRegionClear').disabled = !state.region;
  status.textContent = status.title =
    problem ||
    (drawing
      ? 'Basılı tutup sürükleyerek bölgenin çevresini çizin; bırakınca bölge kapanır. Vazgeçmek için Esc.'
      : state.region
        ? `Bölge seçili (yaklaşık ${marketingKm2(HanMarketingRoute.regionAreaKm2(state.region))}): “Bul” bu bölgede arar, bulunan firmalar bu bölgeyle süzülür.`
        : 'Bölge seçilmedi. Haritada çizerek arama bölgesini belirleyebilirsiniz.');
}

// A new or cleared region re-filters the firms already found.
function marketingSetRegion(region) {
  const state = marketingRouteState;
  state.region = region;
  state.map?.setRegion(region);
  marketingRegionStatus();
  if (state.criteria && !state.job) marketingRenderRows();
}

function marketingMapView() {
  const state = marketingRouteState;
  if (state.mapView) return state.mapView;
  const map = typeof HanMarketingMap === 'undefined' ? null : HanMarketingMap;
  return map?.cityView(state.form.city) || map?.cityView(state.overview?.office?.city) || null;
}

// Google's terms allow Places results only on a Google map; scraped results carry no such rule.
function marketingPinsAllowed() {
  const state = marketingRouteState;
  return !!state.map && (state.source === 'scraper' || state.map.provider === 'google');
}

function marketingMountMap() {
  const state = marketingRouteState,
    box = document.getElementById('marketingMap');
  if (state.map) {
    state.mapView = state.map.view() || state.mapView;
    state.map.destroy();
    state.map = null;
  }
  if (!box || typeof HanMarketingMap === 'undefined') return;
  const mount = (state.mapMount = {});
  HanMarketingMap.create(box, {
    provider: state.overview.map,
    view: marketingMapView(),
    onRegion: (region) => marketingSetRegion(region),
    onToggle: (placeId) => marketingToggleSelected(placeId),
    onHover: (placeId) => {
      for (const row of document.querySelectorAll('#marketingRows tr[data-place]'))
        row.classList.toggle('hover', row.dataset.place === placeId);
    },
    onDrawProblem: (kind) =>
      marketingRegionStatus(
        kind === 'short'
          ? 'Bölge çizilemedi: basılı tutup bölgenin çevresini dolaşacak şekilde sürükleyin.'
          : kind === 'small'
            ? 'Çizilen bölge çok küçük. Haritayı yaklaştırın ya da daha geniş bir alan çizin.'
            : '',
      ),
    onFallback: () => {
      toast('Google haritası açılamadı; OpenStreetMap haritası gösteriliyor.');
      marketingSyncMap();
    },
  })
    .then((map) => {
      // The page may have been redrawn or left while the map was loading.
      if (!map) return;
      if (state.mapMount !== mount || !box.isConnected) return map.destroy();
      state.map = map;
      map.setRegion(state.region);
      marketingRegionStatus();
      marketingSyncMap();
    })
    .catch((error) => {
      if (state.mapMount !== mount || !box.isConnected) return;
      box.innerHTML = `<p class="marketing-map-wait">${esc(
        error?.message || 'Harita yüklenemedi.',
      )} İl ve ilçe seçerek aramaya devam edebilirsiniz.</p>`;
    });
}

// Puts the firms on the list onto the map as dots.
function marketingSyncMap(rows = null) {
  const state = marketingRouteState,
    note = document.getElementById('marketingMapNote');
  if (!state.map) return;
  const shown = rows || (state.criteria && !state.job ? marketingVisible() : []);
  const allowed = marketingPinsAllowed();
  state.map.setPins(
    allowed
      ? shown
          .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
          .map((place) => ({
            placeId: place.placeId,
            lat: place.lat,
            lng: place.lng,
            name: place.name,
            status:
              place.visit?.result === 'İlgilenmiyor'
                ? 'refused'
                : place.visit?.status === 'visited'
                  ? 'visited'
                  : place.visit?.status === 'planned'
                    ? 'planned'
                    : 'new',
            selected: state.selected.has(place.placeId),
          }))
      : [],
  );
  if (!note) return;
  note.innerHTML = !state.criteria
    ? ''
    : allowed
      ? '<span class="marketing-legend"><span class="marketing-dot new"></span>Yeni <span class="marketing-dot planned"></span>Planlandı <span class="marketing-dot visited"></span>Gidildi <span class="marketing-dot refused"></span>İlgilenmiyor <span class="marketing-dot selected"></span>Seçili</span> · Noktaya tıklayarak firmayı seçin.'
      : 'Google koşulları gereği Google’dan gelen firmalar yalnızca Google haritasında nokta olarak gösterilir. Çizdiğiniz bölge yine aramada ve süzmede kullanılır.' +
        (state.overview.canConfigure
          ? ' Noktaları görmek için Ayarlar → Entegrasyonlar → Google Haritalar bölümüne harita anahtarı girin.'
          : '');
}

// After a search: look at the region searched, or at the firms found.
function marketingFitMap() {
  const state = marketingRouteState;
  if (!state.map) return;
  if (state.criteria?.region) return state.map.fitRegion(state.criteria.region);
  if (marketingPinsAllowed() && state.places.length) return state.map.fitPoints(state.places);
  state.map.focusCity(state.criteria?.city);
}

function marketingToggleSelected(placeId) {
  const state = marketingRouteState;
  if (state.selected.has(placeId)) state.selected.delete(placeId);
  else state.selected.add(placeId);
  marketingRenderRows();
}

const marketingPollDelay = () => Number(globalThis.hanMarketingPollMs) || 10000;

async function marketingStartScrape(body, depth, continuation = null) {
  const state = marketingRouteState;
  if (state.loading || state.job) return toast('Bir harita taraması zaten sürüyor.');
  state.loading = true;
  const button = document.getElementById('marketingSearchButton');
  if (button) {
    button.disabled = true;
    button.textContent = 'Başlatılıyor…';
  }
  try {
    const requests = continuation || marketingSectorRequests(body);
    const current = requests[0];
    const result = await marketingRouteRequest('/api/marketing/scrape', { ...current, depth });
    state.job = {
      jobId: result.jobId,
      criteria: current,
      remaining: requests.slice(1),
      depth: result.depth || depth,
      startedAt: Date.now(),
    };
    marketingShowUsage(result.usage);
    if (!continuation) state.criteria = body;
    state.source = 'scraper';
    if (!continuation) state.places = [];
    state.selected = new Set();
    state.plan = null;
    if (!continuation) state.outside = 0;
    state.nextPageToken = '';
    state.filters.district = '';
    marketingSyncMap([]);
  } catch (error) {
    toast(error.message);
    if (continuation && marketingView === 'routes' && state.tab === 'search') {
      marketingRenderResults();
      marketingRenderPlan();
    }
  } finally {
    state.loading = false;
    if (button) {
      button.disabled = !!marketingBlockedNotice() || !!state.job;
      button.textContent = 'Bul';
    }
  }
  if (state.job) {
    marketingRenderScrapeStatus();
    marketingRenderPlan();
    marketingScheduleScrapePoll(marketingPollDelay());
  }
}

function marketingRenderScrapeStatus() {
  const state = marketingRouteState,
    box = document.getElementById('marketingResults');
  if (!box || !state.job) return;
  const seconds = Math.max(0, Math.round((Date.now() - state.job.startedAt) / 1000));
  const elapsed = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const depth = { quick: 'Hızlı', normal: 'Normal', wide: 'Geniş' }[state.job.depth] || 'Normal';
  box.innerHTML = `<div class="formbody marketing-scrape-status" role="status" aria-live="polite">
    <p><b>Harita taraması sürüyor</b> · ${esc(depth)} kapsam · geçen süre <span id="marketingScrapeElapsed">${elapsed}</span></p>
    <p class="marketing-hint">Tarama genellikle birkaç dakika sürer. Sonuçlar hazır olunca liste kendiliğinden gelir; bu sırada başka bölüme geçip dönebilirsiniz.</p>
    <button type="button" class="secondary" id="marketingScrapeCancel">Beklemeyi bırak</button></div>`;
  const button = document.getElementById('marketingSearchButton');
  if (button) button.disabled = true;
  $('#marketingScrapeCancel').onclick = () => {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.job = null;
    state.criteria = null;
    marketingSearchTab();
  };
}

function marketingScheduleScrapePoll(delay) {
  const state = marketingRouteState;
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(marketingPollScrape, delay);
}

// Polls only while Rota Bulma is open; reopening the page resumes a running job.
async function marketingPollScrape() {
  const state = marketingRouteState,
    job = state.job;
  state.pollTimer = null;
  if (!job || marketingView !== 'routes' || state.tab !== 'search') return;
  let result;
  try {
    result = await marketingRouteRequest('/api/marketing/scrape-status', {
      ...job.criteria,
      jobId: job.jobId,
    });
  } catch (error) {
    if (state.job === job) state.job = null;
    toast(error.message);
    if (marketingView === 'routes' && state.tab === 'search') marketingSearchTab();
    return;
  }
  if (state.job !== job) return;
  if (result.status !== 'ok') {
    marketingRenderScrapeStatus();
    return marketingScheduleScrapePoll(marketingPollDelay());
  }
  state.job = null;
  const known = new Set(state.places.map((place) => place.placeId));
  for (const place of result.places || [])
    if (!known.has(place.placeId)) {
      known.add(place.placeId);
      state.places.push(place);
    }
  state.outside += result.outside || 0;
  if (job.remaining?.length) return marketingStartScrape(state.criteria, job.depth, job.remaining);
  if (marketingView === 'routes' && state.tab === 'search' && document.getElementById('marketingResults')) {
    const button = document.getElementById('marketingSearchButton');
    if (button) button.disabled = !!marketingBlockedNotice();
    marketingRenderResults();
    marketingRenderPlan();
    marketingFitMap();
  }
}

function marketingSearchInput(form) {
  const fail = (input, message) => {
    input.setCustomValidity(message);
    input.reportValidity();
    input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
    input.addEventListener('change', () => input.setCustomValidity(''), { once: true });
    return null;
  };
  const same = (a, b) => String(a).toLocaleLowerCase('tr') === String(b).trim().toLocaleLowerCase('tr');
  const sectors = [...form.querySelectorAll('[name="sector"]:checked')].map((input) => input.value);
  const sector = sectors[0] || '';
  const customQuery = form.elements.customQuery.value.trim();
  const typedCity = form.elements.city.value.trim(),
    typedDistrict = form.elements.district.value.trim();
  const city = Object.keys(turkeyDistricts).find((name) => same(name, typedCity)) || '';
  const district = (turkeyDistricts[city] || []).find((name) => same(name, typedDistrict)) || '';
  const region = marketingRouteState.region;
  if (sectors.includes('custom') && customQuery.length < 2)
    return fail(form.elements.customQuery, 'Aranacak sektörü yazın.');
  // A place is all a search needs: a province, or a region drawn on the map.
  if (typedCity && !city) return fail(form.elements.city, 'Listeden bir il seçin.');
  if (!city && !region) return fail(form.elements.city, 'Bir il seçin veya haritada bir bölge çizin.');
  if (typedDistrict && !district)
    return fail(form.elements.district, 'Listeden bir ilçe seçin ya da ilçeyi boş bırakın.');
  const fields = {
    sector,
    ...(sectors.length > 1 ? { sectors } : {}),
    customQuery: sectors.includes('custom') ? customQuery : '',
    city,
    district,
    neighborhood: form.elements.neighborhood.value.trim(),
    avenue: form.elements.avenue.value.trim(),
    street: form.elements.street.value.trim(),
  };
  Object.assign(marketingRouteState.form, fields, { sectors });
  return region ? { ...fields, region } : fields;
}

// `source` is 'google' (the office's own key) or 'platform' (the subscribed map service).
function marketingSectorRequests(body) {
  const { sectors, ...single } = body;
  return (sectors || [body.sector || '']).map((sector) => ({ ...single, sector }));
}

async function marketingSearch(body, more = false, source = 'google') {
  const state = marketingRouteState;
  if (state.loading || state.job) return;
  if (more) source = state.source;
  const via = source === 'platform' ? { source: 'platform' } : {};
  const requests = more
    ? state.nextSearchRequests || [{ ...state.criteria, pageToken: state.nextPageToken }]
    : marketingSectorRequests(body);
  state.loading = true;
  if (!more) {
    state.criteria = body;
    state.source = source;
    state.places = [];
    state.selected = new Set();
    state.plan = null;
    state.outside = 0;
    state.filters.district = '';
  }
  state.nextSearchRequests = [];
  const button = document.getElementById(more ? 'marketingMore' : 'marketingSearchButton');
  if (button) {
    button.disabled = true;
    button.textContent = 'Aranıyor…';
  }
  const searchButton = document.getElementById('marketingSearchButton');
  if (searchButton) searchButton.disabled = true;
  let index = 0;
  try {
    for (; index < requests.length; index++) {
      if (button) button.textContent = 'Aranıyor… ' + (index + 1) + '/' + requests.length;
      const input = requests[index];
      const result = await marketingRouteRequest('/api/marketing/search', { ...input, ...via });
      const known = new Set(state.places.map((place) => place.placeId));
      for (const place of result.places || [])
        if (!known.has(place.placeId)) {
          known.add(place.placeId);
          state.places.push(place);
        }
      if (result.nextPageToken) state.nextSearchRequests.push({ ...input, pageToken: result.nextPageToken });
      state.outside += result.outside || 0;
      if (Number.isFinite(result.searchesLeft) && state.overview.service) {
        state.overview.service.searchesLeft = result.searchesLeft;
        const note = document.getElementById('marketingServiceNote');
        if (note) note.textContent = marketingServiceNote();
      }
      marketingShowUsage(result.usage);
    }
  } catch (error) {
    state.nextSearchRequests.push(...requests.slice(index));
    toast(error.message + ' Tamamlanmayan sektörler için Daha Fazla Getir ile yeniden deneyebilirsiniz.');
  } finally {
    state.nextPageToken = state.nextSearchRequests.length ? 'sectors' : '';
    state.loading = false;
    if (marketingView === 'routes' && state.tab === 'search' && document.getElementById('marketingResults')) {
      const search = document.getElementById('marketingSearchButton');
      if (search) {
        search.disabled = !!marketingBlockedNotice();
        search.textContent = 'Bul';
      }
      marketingRenderResults();
      marketingRenderPlan();
      if (!more) marketingFitMap();
    }
  }
}

function marketingOfficeAddress() {
  const office = marketingRouteState.overview?.office || {};
  return office.address ? [office.address, office.district, office.city].filter(Boolean).join(', ') : '';
}

function marketingOriginPoint() {
  const origin = marketingRouteState.origin;
  return origin.mode === 'location' && Number.isFinite(origin.lat)
    ? { lat: origin.lat, lng: origin.lng }
    : null;
}

function marketingLinkOrigin(
  mode = marketingRouteState.origin.mode,
  label = marketingRouteState.origin.label,
) {
  if (mode === 'location') return marketingOriginPoint();
  if (mode === 'office') return marketingOfficeAddress() ? { text: marketingOfficeAddress() } : null;
  if (mode === 'address' && String(label || '').trim()) return { text: String(label).trim() };
  return null;
}

function marketingOriginLabel(
  mode = marketingRouteState.origin.mode,
  label = marketingRouteState.origin.label,
) {
  if (mode === 'location') return 'Başlangıç: mevcut konumunuz';
  if (mode === 'office' && marketingOfficeAddress()) return 'Başlangıç: büro — ' + marketingOfficeAddress();
  if (mode === 'address' && String(label || '').trim()) return 'Başlangıç: ' + String(label).trim();
  return 'Başlangıç: Google Haritalar telefonun konumunu kullanır';
}

function marketingVisible() {
  const state = marketingRouteState;
  return HanMarketingRoute.filterPlaces(state.places, state.filters, marketingOriginPoint(), state.region);
}

function marketingVisitBadge(visit) {
  if (!visit) return '<span class="marketing-status">Yeni</span>';
  const date = marketingDate(visit.date);
  if (visit.status === 'planned')
    return `<span class="marketing-status planned">Planlandı</span><small>${esc(
      [date, visit.staffName].filter(Boolean).join(' · '),
    )}</small>`;
  const refused = visit.result === 'İlgilenmiyor';
  return `<span class="marketing-status ${refused ? 'refused' : 'visited'}">Gidildi${
    visit.result ? ': ' + esc(visit.result) : ''
  }</span><small>${esc([date, visit.staffName || (visit.own ? '' : 'Başka personel')].filter(Boolean).join(' · '))}</small>`;
}

function marketingRenderResults() {
  const state = marketingRouteState,
    box = document.getElementById('marketingResults');
  if (!box) return;
  if (!state.criteria) {
    box.innerHTML = '';
    return;
  }
  const filters = state.filters,
    point = marketingOriginPoint(),
    office = marketingOfficeAddress(),
    criteria = state.criteria;
  const sector = (criteria.sectors || [criteria.sector])
    .map((id) =>
      id === 'custom'
        ? criteria.customQuery
        : state.overview.sectors.find((item) => item.id === id)?.label || 'Tüm firmalar',
    )
    .join(', ');
  // The districts the firms are in: a province-wide search is narrowed with these.
  const districts = HanMarketingRoute.districtCounts(state.places);
  if (
    !districts.some((item) => HanMarketingRoute.fold(item.name) === HanMarketingRoute.fold(filters.district))
  )
    filters.district = '';
  const options = (values, current) =>
    values
      .map(
        ([value, label, disabled]) =>
          // District names come from the map service: escaped as a value too.
          `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`,
      )
      .join('');
  const check = (name, label) =>
    `<label class="settings-check"><input type="checkbox" name="${name}" ${filters[name] ? 'checked' : ''}> ${label}</label>`;
  box.innerHTML = `<div class="marketing-section-head"><h3>${esc(
    [sector, marketingAreaLabel(criteria)].join(' · '),
  )}</h3><small>Kaynak: ${esc(marketingSourceLabel(state.source))} · Bulunan firmaları aşağıdaki süzgeçlerle ve haritada bölge çizerek azaltabilirsiniz.</small></div>
    <div class="marketing-filters" id="marketingFilters">
      <label class="field">Başlangıç noktası<select name="originMode">${options(
        [
          ['none', 'Google Haritalar konumumu kullansın'],
          ['location', 'Mevcut konumum (mesafe hesaplanır)'],
          ['office', office ? 'Büro adresi' : 'Büro adresi (Ayarlar’da kayıtlı değil)', !office],
          ['address', 'Elle adres yazın'],
        ],
        state.origin.mode,
      )}</select></label>
      <label class="field" id="marketingOriginAddress" ${state.origin.mode === 'address' ? '' : 'hidden'}>Başlangıç adresi<input name="originAddress" maxlength="200" value="${esc(state.origin.label)}" placeholder="Adres veya yer adı"></label>
      <label class="field">Telefon<select name="phone">${options(
        [
          ['', 'Tümü'],
          ['any', 'Telefonu olanlar'],
          ['mobile', 'Cep telefonu olanlar'],
        ],
        filters.phone,
      )}</select></label>
      <label class="field">Ziyaret durumu<select name="visit">${options(
        [
          ['all', 'Tümü'],
          ['notVisited', 'Daha önce gidilmeyenler'],
          ['fresh', 'Hiç rotaya alınmamışlar'],
          ['planned', 'Planlananlar'],
          ['visited', 'Gidilenler'],
          ['revisit', 'Tekrar gidilecekler'],
        ],
        filters.visit,
      )}</select></label>
      <label class="field" ${point ? '' : 'title="Mesafe için başlangıç noktasında “Mevcut konumum”u seçin."'}>Mesafe<select name="maxKm" ${point ? '' : 'disabled'}>${options(
        [
          // Without a location the closed box itself says what to do: no extra line of text.
          [0, point ? 'Tümü' : 'Önce “Mevcut konumum”u seçin'],
          [1, '1 km içinde'],
          [3, '3 km içinde'],
          [5, '5 km içinde'],
          [10, '10 km içinde'],
        ],
        point ? filters.maxKm : 0,
      )}</select></label>
      <label class="field">Google puanı<select name="minRating">${options(
        [
          [0, 'Tümü'],
          [3.5, '3,5 ve üzeri'],
          [4, '4 ve üzeri'],
          [4.5, '4,5 ve üzeri'],
        ],
        filters.minRating,
      )}</select></label>
      <label class="field">En az yorum<input name="minReviews" type="number" min="0" max="100000" step="1" value="${filters.minReviews || ''}" placeholder="0"></label>
      <label class="field">Web sitesi<select name="website">${options(
        [
          ['', 'Tümü'],
          ['yes', 'Olanlar'],
          ['no', 'Olmayanlar'],
        ],
        filters.website,
      )}</select></label>
      <label class="field">Sırala<select name="sort">${options(
        [
          ['', 'Google sırası'],
          ['distance', 'Mesafe (yakından uzağa)', !point],
          ['rating', 'Google puanı'],
          ['reviews', 'Yorum sayısı'],
          ['name', 'Firma adı'],
        ],
        filters.sort === 'distance' && !point ? '' : filters.sort,
      )}</select></label>
      <label class="field">İlçe<select name="district" ${districts.length > 1 ? '' : 'disabled'}>${options(
        [['', 'Tüm ilçeler'], ...districts.map((item) => [item.name, `${item.name} (${item.count})`])],
        filters.district,
      )}</select></label>
      <label class="field">Ara<input name="query" type="search" maxlength="80" value="${esc(filters.query)}" placeholder="Firma adı veya adres"></label>
      <label class="field">Adında geçmesin<input name="exclude" type="search" maxlength="120" value="${esc(filters.exclude)}" placeholder="ör. avm, şube"></label>
      ${criteria.district ? check('districtOnly', 'Yalnızca seçilen ilçe') : ''}${check('openNow', 'Şu an açık olanlar')}${check(
        'hideClosed',
        'Kapanmış işletmeleri gizle',
      )}${check('hideRefused', '“İlgilenmiyor” diyenleri gizle')}
    </div>
    <div class="marketing-narrow"><button type="button" class="secondary" id="marketingKeepVisible" title="Süzgeçlere ve çizilen bölgeye uymayan firmaları listeden kalıcı olarak çıkarır">Yalnızca görünenleri tut</button><button type="button" class="secondary" id="marketingResetFilters" title="Tüm süzgeçleri ilk hâline döndürür">Süzgeçleri sıfırla</button><span class="marketing-hint">Tek bir firmayı çıkarmak için satırındaki ✕ düğmesini kullanın.</span></div>
    <div class="overflow"><table class="marketing-results"><thead><tr><th class="marketing-check"><input type="checkbox" id="marketingSelectAll" aria-label="Görünen firmaların tümünü seç"></th><th>FİRMA</th><th>ADRES</th><th>TELEFON</th><th>PUAN</th><th>MESAFE</th><th>DURUM</th><th class="marketing-drop" aria-label="Listeden çıkar"></th></tr></thead><tbody id="marketingRows"></tbody></table></div>
    <div class="tablefoot marketing-foot"><span id="marketingResultSummary" role="status" aria-live="polite"></span><span class="marketing-foot-actions">${
      state.nextPageToken
        ? '<button type="button" class="secondary" id="marketingMore">Daha fazla getir (+20)</button>'
        : ''
    }<span class="marketing-attribution">Google Maps</span></span></div>
    <div class="actions"><button type="button" class="primary" id="marketingBuild">Rota Oluştur</button><button type="button" class="secondary" id="marketingClear">Seçimi temizle</button></div>`;
  const panel = $('#marketingFilters');
  panel.querySelectorAll('select, input').forEach((input) => {
    const update = () => {
      const name = input.name;
      if (name === 'originMode') return marketingChangeOrigin(input);
      if (name === 'originAddress') {
        state.origin.label = input.value;
        return marketingRenderPlan();
      }
      if (input.type === 'checkbox') filters[name] = input.checked;
      else if (['maxKm', 'minRating', 'minReviews'].includes(name))
        filters[name] = Math.max(0, Number(input.value) || 0);
      else filters[name] = input.value;
      marketingRenderRows();
    };
    input.addEventListener(input.type === 'search' || input.type === 'number' ? 'input' : 'change', update);
  });
  $('#marketingSelectAll').onchange = (event) => {
    for (const place of marketingVisible())
      if (event.target.checked) state.selected.add(place.placeId);
      else state.selected.delete(place.placeId);
    marketingRenderRows();
  };
  const more = document.getElementById('marketingMore');
  if (more) more.onclick = () => marketingSearch(null, true);
  $('#marketingBuild').onclick = marketingBuildPlan;
  $('#marketingClear').onclick = () => {
    state.selected.clear();
    marketingRenderRows();
  };
  // Narrowing for good: what the filters and the drawn region hide leaves the list.
  $('#marketingKeepVisible').onclick = () => {
    const keep = new Set(marketingVisible().map((place) => place.placeId));
    const dropped = state.places.length - keep.size;
    if (!dropped) return toast('Çıkarılacak firma yok: listedeki tüm firmalar görünüyor.');
    state.places = state.places.filter((place) => keep.has(place.placeId));
    for (const id of [...state.selected]) if (!keep.has(id)) state.selected.delete(id);
    marketingRenderResults();
    toast(`${dropped} firma listeden çıkarıldı. ${state.places.length} firma kaldı.`);
  };
  $('#marketingResetFilters').onclick = () => {
    Object.assign(filters, MARKETING_FILTER_DEFAULTS);
    marketingRenderResults();
  };
  marketingRenderRows();
}

function marketingChangeOrigin(select) {
  const state = marketingRouteState;
  const mode = select.value;
  if (mode !== 'location') {
    state.origin = { ...state.origin, mode, lat: null, lng: null };
    if (state.filters.sort === 'distance') state.filters.sort = '';
    marketingRenderResults();
    marketingRenderPlan();
    return;
  }
  if (!navigator.geolocation) {
    select.value = state.origin.mode;
    return toast('Bu tarayıcı konum paylaşımını desteklemiyor.');
  }
  select.disabled = true;
  $('#marketingResultSummary').textContent = 'Konumunuz alınıyor…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.origin = {
        ...state.origin,
        mode: 'location',
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      marketingRenderResults();
      marketingRenderPlan();
    },
    (error) => {
      state.origin = { ...state.origin, mode: 'none', lat: null, lng: null };
      marketingRenderResults();
      toast(
        error?.code === 1
          ? 'Konum izni verilmedi. Tarayıcının adres çubuğundan bu site için konum iznini açın.'
          : 'Konumunuz alınamadı. Tekrar deneyin.',
      );
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

function marketingRowHtml(place) {
  const route = HanMarketingRoute,
    selected = marketingRouteState.selected.has(place.placeId);
  const mapsUrl =
    'https://www.google.com/maps/search/?' +
    new URLSearchParams({ api: '1', query: place.name, query_place_id: place.placeId });
  const notes = [
    place.inDistrict === false ? 'İlçe dışı' : '',
    place.businessStatus === 'CLOSED_PERMANENTLY'
      ? 'Kalıcı olarak kapalı'
      : place.businessStatus === 'CLOSED_TEMPORARILY'
        ? 'Geçici olarak kapalı'
        : '',
    place.openNow === true ? 'Şu an açık' : place.openNow === false ? 'Şu an kapalı' : '',
  ].filter(Boolean);
  const website = marketingSafeUrl(place.website);
  const phone = place.phone
    ? `<a href="tel:${esc(route.phoneDigits(place.phone))}">${esc(place.phone)}</a>${
        route.isMobilePhone(place.phone) ? ' <span class="marketing-tag" title="Cep telefonu">Cep</span>' : ''
      }`
    : '—';
  const rating = Number.isFinite(place.rating)
    ? `${place.rating.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ★ <span class="marketing-tag" title="Yorum sayısı">${Number(
        place.ratingCount || 0,
      ).toLocaleString('tr-TR')} yorum</span>`
    : '—';
  return `<tr class="${selected ? 'selected' : ''}" data-place="${esc(place.placeId)}"><td class="marketing-check"><input type="checkbox" data-place-check="${esc(
    place.placeId,
  )}" ${selected ? 'checked' : ''} aria-label="${esc(place.name)} seç"></td><td><a href="${esc(
    mapsUrl,
  )}" target="_blank" rel="noopener noreferrer">${esc(place.name)}</a>${
    // One line under the name: what is known about the firm, then its web site.
    notes.length || website
      ? `<small>${esc(notes.join(' · '))}${notes.length && website ? ' · ' : ''}${
          website
            ? `<a href="${esc(website)}" target="_blank" rel="noopener noreferrer nofollow">Web sitesi</a>`
            : ''
        }</small>`
      : ''
  }</td><td>${esc(
    place.address,
  )}</td><td class="marketing-nowrap">${phone}</td><td class="marketing-nowrap">${rating}</td><td>${place.distance === null ? '—' : marketingKm(place.distance)}</td><td>${marketingVisitBadge(
    place.visit,
  )}</td><td class="marketing-drop"><button type="button" class="link" data-place-drop="${esc(
    place.placeId,
  )}" title="Listeden çıkar" aria-label="${esc(place.name)} listeden çıkar">✕</button></td></tr>`;
}

function marketingRenderRows() {
  const state = marketingRouteState,
    body = document.getElementById('marketingRows');
  if (!body) return;
  const rows = marketingVisible();
  // Firms the drawn region alone hides: searching again inside it would find more there.
  const outsideRegion = state.region
    ? state.places.length - HanMarketingRoute.filterPlaces(state.places, {}, null, state.region).length
    : 0;
  body.innerHTML =
    rows.map(marketingRowHtml).join('') ||
    `<tr><td colspan="8" class="empty">${
      !state.places.length
        ? 'Bu aramada firma bulunamadı. Sektörü, ilçeyi veya mahalle, cadde ve sokak alanlarını boşaltıp ya da daha geniş bir bölge çizip yeniden deneyin.'
        : outsideRegion === state.places.length
          ? 'Bulunan firmaların hiçbiri çizdiğiniz bölgede değil. Bu bölgede aramak için “Bul”a basın ya da bölgeyi silin.'
          : 'Süzgeçlere uyan firma yok. Süzgeçleri gevşetin.'
    }</td></tr>`;
  body.querySelectorAll('[data-place-check]').forEach(
    (input) =>
      (input.onchange = () => {
        if (input.checked) state.selected.add(input.dataset.placeCheck);
        else state.selected.delete(input.dataset.placeCheck);
        input.closest('tr').classList.toggle('selected', input.checked);
        marketingSyncSelection(rows);
        marketingSyncMap(rows);
      }),
  );
  body.querySelectorAll('[data-place-drop]').forEach(
    (button) =>
      (button.onclick = () => {
        const id = button.dataset.placeDrop;
        state.places = state.places.filter((place) => place.placeId !== id);
        state.selected.delete(id);
        marketingRenderRows();
      }),
  );
  // Pointing at a row shows where that firm is on the map.
  body.querySelectorAll('tr[data-place]').forEach((row) => {
    row.onmouseenter = () => state.map?.highlight(row.dataset.place);
    row.onmouseleave = () => state.map?.highlight(null);
  });
  marketingSyncSelection(rows, outsideRegion);
  marketingSyncMap(rows);
}

function marketingSyncSelection(rows, outsideRegion = 0) {
  const state = marketingRouteState,
    all = document.getElementById('marketingSelectAll');
  const shown = rows.filter((place) => state.selected.has(place.placeId)).length,
    hidden = state.selected.size - shown;
  all.checked = rows.length > 0 && shown === rows.length;
  all.indeterminate = shown > 0 && shown < rows.length;
  all.disabled = !rows.length;
  $('#marketingResultSummary').textContent =
    `${rows.length} firma gösteriliyor · toplam ${state.places.length}` +
    (outsideRegion ? ` · ${outsideRegion} tanesi çizilen bölgenin dışında` : '') +
    (state.outside
      ? ` · ${state.outside} ${state.criteria?.region ? 'bölge' : 'il'} dışı sonuç çıkarıldı`
      : '') +
    ` · ${state.selected.size} seçili` +
    (hidden > 0 ? ` (${hidden} tanesi süzgeç nedeniyle görünmüyor)` : '');
  const build = $('#marketingBuild');
  build.textContent = `Rota Oluştur (${state.selected.size})`;
  build.disabled = !state.selected.size;
}

function marketingBuildPlan() {
  const state = marketingRouteState;
  const chosen = state.places.filter((place) => state.selected.has(place.placeId));
  if (!chosen.length) return toast('Rota için en az bir firma seçin.');
  if (chosen.length > 60) return toast('Bir rotaya en fazla 60 firma eklenebilir. Seçimi azaltın.');
  state.plan = {
    requestId: marketingRequestId(),
    savedId: '',
    name: state.plan?.name || '',
    perLink: state.plan?.perLink || 10,
    travelMode: state.plan?.travelMode || 'driving',
    stops: HanMarketingRoute.orderStops(chosen, marketingOriginPoint()),
  };
  marketingRenderPlan();
  document.getElementById('marketingPlan')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

// The district and province searched; a search by drawn region alone has neither.
const marketingPlaceName = (criteria) =>
  criteria
    ? [criteria.district, criteria.city].filter(Boolean).join(' / ') || 'Çizilen bölge'
    : 'Ziyaret rotası';

function marketingPlanTitle(name, stops, criteria) {
  return 'Rota: ' + (name || marketingPlaceName(criteria)) + ' (' + stops.length + ' durak)';
}

// Share actions open real links. Saving happens in the same click so the
// stops show as "Planlandı" even when the person only opens or sends the route.
function marketingSharePanel(links, text, phone) {
  return `<div class="actions marketing-links">${links
    .map(
      (link, index) =>
        `<a class="primary" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" data-route-share>${
          links.length > 1
            ? `Google Haritalar’da Aç · Bölüm ${index + 1}/${links.length} (durak ${link.from}–${link.to})`
            : 'Google Haritalar’da Aç'
        }</a>`,
    )
    .join('')}<a class="secondary marketing-whatsapp" href="${esc(
    HanMarketingRoute.whatsappLink(phone, text),
  )}" target="_blank" rel="noopener noreferrer" data-route-share>WhatsApp’a Gönder</a><button type="button" class="secondary" data-route-copy>Rotayı Kopyala</button></div>`;
}

function marketingBindShare(container, text, onShare) {
  container.querySelectorAll('[data-route-share]').forEach(
    (link) =>
      (link.onclick = () => {
        if (onShare) onShare();
      }),
  );
  container.querySelectorAll('[data-route-copy]').forEach(
    (button) =>
      (button.onclick = async () => {
        if (onShare) onShare();
        try {
          await navigator.clipboard.writeText(text);
          toast('Rota metni ve bağlantılar panoya kopyalandı.');
        } catch {
          const area = document.createElement('textarea');
          area.className = 'marketing-copy';
          area.readOnly = true;
          area.value = text;
          button.after(area);
          area.select();
          toast('Metin seçildi. Kopyalamak için Ctrl+C tuşlarına basın.');
        }
      }),
  );
}

function marketingSavePlan({ quiet = false } = {}) {
  const state = marketingRouteState,
    plan = state.plan;
  if (!plan || plan.savedId) return true;
  try {
    const mode = state.origin.mode === 'location' && !marketingOriginPoint() ? 'none' : state.origin.mode;
    const result = authApi('/api/marketing/routes', 'POST', {
      ...state.criteria,
      requestId: plan.requestId,
      name: plan.name,
      origin: {
        mode,
        label: mode === 'office' ? marketingOfficeAddress() : mode === 'address' ? state.origin.label : '',
      },
      travelMode: plan.travelMode,
      source: state.source,
      stops: plan.stops.map((stop) => stop.placeId),
      // Scraped routes keep a copy of what was found; Google routes keep IDs only.
      ...(state.source === 'scraper'
        ? {
            places: plan.stops.map(({ placeId, name, address, phone, lat, lng }) => ({
              placeId,
              name,
              address,
              phone,
              lat,
              lng,
            })),
          }
        : {}),
    });
    plan.savedId = result.route.id;
    if (!state.overview.routes.some((item) => item.id === result.route.id))
      state.overview.routes.unshift(result.route);
    const today = typeof businessDate === 'function' ? businessDate() : new Date().toISOString().slice(0, 10);
    for (const stop of plan.stops) {
      const place = state.places.find((item) => item.placeId === stop.placeId);
      if (place && !place.visit)
        place.visit = {
          status: 'planned',
          result: '',
          date: today,
          staffName: hanAuth?.name || '',
          own: true,
        };
    }
    if (!quiet) toast('Rota kaydedildi.');
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

function marketingRenderPlan() {
  const state = marketingRouteState,
    box = document.getElementById('marketingPlan'),
    plan = state.plan;
  if (!box) return;
  if (!plan) {
    box.innerHTML = '';
    return;
  }
  const route = HanMarketingRoute;
  const links = route.directionsLinks({
    origin: marketingLinkOrigin(),
    stops: plan.stops,
    perLink: plan.perLink,
    travelMode: plan.travelMode,
  });
  const text = route.whatsappText({
    title: marketingPlanTitle(plan.name, plan.stops, state.criteria),
    stops: plan.stops,
    links,
  });
  const fallbackName = marketingPlaceName(state.criteria);
  box.innerHTML = `<section class="marketing-plan" aria-labelledby="marketingPlanTitle">
    <div class="panelhead"><div><h2 id="marketingPlanTitle">Rota · ${plan.stops.length} durak</h2><p>${esc(
      marketingOriginLabel(),
    )}${plan.savedId ? ' · Kaydedildi' : ''}</p></div></div>
    <div class="formbody grid marketing-plan-fields">
      <label class="field">Rota adı<input id="marketingPlanName" maxlength="120" value="${esc(plan.name)}" placeholder="${esc(
        fallbackName,
      )}" ${plan.savedId ? 'disabled' : ''}></label>
      <label class="field">Ulaşım<select id="marketingTravelMode"><option value="driving">Araçla</option><option value="walking">Yürüyerek</option></select></label>
      <label class="field" title="Google tek bağlantıda en çok 10 durağa (telefon tarayıcısında 4) izin verir; uzun rotalar bölümlere ayrılır.">Bağlantı başına durak<select id="marketingPerLink"><option value="10">10 durak — bilgisayar ve Google Haritalar uygulaması</option><option value="4">4 durak — telefon tarayıcısı</option></select></label>
    </div>
    <ol class="marketing-stops">${plan.stops
      .map(
        (stop, index) =>
          `<li><span><b>${esc(stop.name)}</b><small>${esc(
            [stop.address, stop.phone].filter(Boolean).join(' · '),
          )}</small></span><span class="marketing-stop-actions"><button type="button" class="link" data-stop-move="${index}" data-step="-1" ${
            index === 0 ? 'disabled' : ''
          } aria-label="${esc(stop.name)} yukarı taşı">↑</button><button type="button" class="link" data-stop-move="${index}" data-step="1" ${
            index === plan.stops.length - 1 ? 'disabled' : ''
          } aria-label="${esc(stop.name)} aşağı taşı">↓</button><button type="button" class="link" data-stop-remove="${index}" aria-label="${esc(
            stop.name,
          )} rotadan çıkar">✕</button></span></li>`,
      )
      .join('')}</ol>
    <div class="marketing-action-row"><div class="actions"><button type="button" class="secondary" id="marketingReorder">Sırayı Yeniden Hesapla</button><button type="button" class="secondary" id="marketingSavePlan" ${
      plan.savedId ? 'disabled' : ''
    }>${plan.savedId ? 'Rota kaydedildi' : 'Rotayı Kaydet'}</button></div>${marketingSharePanel(links, text, state.overview.selfPhone)}</div>
    <p class="formbody marketing-hint">${
      state.overview.selfPhone
        ? 'WhatsApp mesajı kayıtlı numaranıza (+' +
          esc(state.overview.selfPhone) +
          ') hazırlanır; göndermeden önce başka bir kişi de seçebilirsiniz.'
        : 'Hesabınızda WhatsApp numarası kayıtlı değil; WhatsApp açılınca mesajı göndereceğiniz kişiyi seçin.'
    } Rotayı açtığınızda, gönderdiğinizde veya kopyaladığınızda rota kaydedilir ve duraklar “Planlandı” görünür.</p>
  </section>`;
  const changed = () => {
    plan.requestId = marketingRequestId();
    plan.savedId = '';
    marketingRenderPlan();
  };
  $('#marketingTravelMode').value = plan.travelMode;
  $('#marketingPerLink').value = String(plan.perLink);
  $('#marketingPlanName').oninput = (event) => (plan.name = event.target.value);
  $('#marketingTravelMode').onchange = (event) => {
    plan.travelMode = event.target.value;
    changed();
  };
  $('#marketingPerLink').onchange = (event) => {
    plan.perLink = Number(event.target.value) || 10;
    marketingRenderPlan();
  };
  box.querySelectorAll('[data-stop-move]').forEach(
    (button) =>
      (button.onclick = () => {
        const from = Number(button.dataset.stopMove),
          to = from + Number(button.dataset.step);
        [plan.stops[from], plan.stops[to]] = [plan.stops[to], plan.stops[from]];
        changed();
      }),
  );
  box.querySelectorAll('[data-stop-remove]').forEach(
    (button) =>
      (button.onclick = () => {
        const [removed] = plan.stops.splice(Number(button.dataset.stopRemove), 1);
        state.selected.delete(removed.placeId);
        if (!plan.stops.length) state.plan = null;
        marketingRenderRows();
        if (state.plan) changed();
        else marketingRenderPlan();
      }),
  );
  $('#marketingReorder').onclick = () => {
    plan.stops = HanMarketingRoute.orderStops(plan.stops, marketingOriginPoint());
    changed();
  };
  $('#marketingSavePlan').onclick = () => {
    if (marketingSavePlan()) {
      marketingRenderRows();
      marketingRenderPlan();
    }
  };
  // Defer re-rendering so the clicked link still opens normally.
  marketingBindShare(box, text, () => {
    if (!plan.savedId && marketingSavePlan({ quiet: true }))
      setTimeout(() => {
        marketingRenderRows();
        marketingRenderPlan();
      }, 0);
  });
}

function marketingSavedRoutes() {
  const state = marketingRouteState,
    body = $('#marketingRouteBody');
  if (state.saved) return marketingSavedRouteDetail();
  const routes = state.overview.routes;
  body.innerHTML = `<div class="overflow"><table class="marketing-saved-table"><thead><tr><th>TARİH</th><th>ROTA</th><th>BÖLGE</th><th>DURAK</th><th>GİDİLEN</th><th>OLUŞTURAN</th><th>İŞLEM</th></tr></thead><tbody>${
    routes
      .map(
        (route) =>
          `<tr><td>${esc(marketingDate(route.createdAt))}</td><td>${esc(route.name)}<small>${esc(
            route.sectorLabel,
          )}</small></td><td>${esc(marketingAreaLabel(route))}</td><td>${route.stops.length}</td><td>${route.visitedCount}/${route.stops.length}</td><td>${esc(
            route.createdByName,
          )}</td><td><button type="button" class="link" data-open-route="${esc(route.id)}">Aç</button></td></tr>`,
      )
      .join('') ||
    '<tr><td colspan="7" class="empty">Henüz kayıtlı rota yok. “Firma Bul ve Rota Oluştur” sekmesinden rota oluşturun.</td></tr>'
  }</tbody></table></div><p class="formbody marketing-hint">Kayıtlı rota açılırken firma adları ve adresleri Google Haritalar’dan yeniden alınır${
    state.overview.service
      ? '; hazır harita servisiyle bulunan rotalarda her firma aylık rota yenileme hakkından düşer'
      : ''
  }.</p>`;
  body
    .querySelectorAll('[data-open-route]')
    .forEach((button) => (button.onclick = () => marketingOpenRoute(button.dataset.openRoute, button)));
}

async function marketingOpenRoute(id, button) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Yükleniyor…';
  }
  try {
    marketingRouteState.saved = await marketingRouteRequest('/api/marketing/route-places', { routeId: id });
  } catch (error) {
    toast(error.message);
  }
  if (
    marketingView === 'routes' &&
    marketingRouteState.tab === 'saved' &&
    document.getElementById('marketingRouteBody')
  )
    marketingSavedRoutes();
}

function marketingSavedRouteDetail() {
  const state = marketingRouteState,
    { route, places } = state.saved,
    tools = HanMarketingRoute;
  const stops = places.filter((place) => !place.missing);
  const links = stops.length
    ? tools.directionsLinks({
        origin: marketingLinkOrigin(route.origin?.mode, route.origin?.label),
        stops,
        perLink: state.savedPerLink,
        travelMode: route.travelMode,
      })
    : [];
  const text = tools.whatsappText({ title: marketingPlanTitle(route.name, stops, null), stops, links });
  const visited = places.filter((place) => place.visit?.status === 'visited').length;
  $('#marketingRouteBody').innerHTML =
    `<div class="formbody marketing-saved-head"><button type="button" class="secondary" id="marketingSavedBack">← Rotalarım</button><div><h3>${esc(
      route.name,
    )}</h3><p>${esc(
      [
        marketingDate(route.createdAt),
        route.sectorLabel,
        marketingAreaLabel(route),
        route.createdByName,
        marketingOriginLabel(route.origin?.mode, route.origin?.label),
      ]
        .filter(Boolean)
        .join(' · '),
    )}</p></div></div>
    <div class="overflow"><table class="marketing-saved-table"><thead><tr><th>#</th><th>FİRMA</th><th>ADRES</th><th>DURUM</th><th>İŞLEM</th></tr></thead><tbody>${places
      .map(
        (place, index) =>
          `<tr><td>${index + 1}</td><td>${
            place.missing ? '<span class="muted">Google Haritalar kaydı bulunamadı</span>' : esc(place.name)
          }</td><td>${esc(place.address)}</td><td>${marketingVisitBadge(place.visit)}</td><td>${
            place.missing
              ? ''
              : `<a class="link" href="${esc(
                  tools.directionsUrl(null, [place], route.travelMode),
                )}" target="_blank" rel="noopener noreferrer">Yol tarifi</a>${
                  marketingReadOnly()
                    ? ''
                    : `<button type="button" class="link" data-record-visit="${index}">Ziyareti Kaydet</button>`
                }`
          }</td></tr>`,
      )
      .join('')}</tbody></table></div>
    <div class="tablefoot marketing-foot"><span>${visited}/${places.length} durak ziyaret edildi</span><span class="marketing-attribution">Google Maps</span></div>
    <div class="marketing-action-row"><label class="field marketing-inline-field">Bağlantı başına durak<select id="marketingSavedPerLink"><option value="10">10 durak — bilgisayar ve Google Haritalar uygulaması</option><option value="4">4 durak — telefon tarayıcısı</option></select></label>${
      links.length ? marketingSharePanel(links, text, state.overview.selfPhone) : ''
    }</div>`;
  $('#marketingSavedBack').onclick = () => {
    state.saved = null;
    marketingRoutePage();
  };
  $('#marketingSavedPerLink').value = String(state.savedPerLink);
  $('#marketingSavedPerLink').onchange = (event) => {
    state.savedPerLink = Number(event.target.value) || 10;
    marketingSavedRouteDetail();
  };
  document
    .querySelectorAll('[data-record-visit]')
    .forEach(
      (button) => (button.onclick = () => marketingVisitDialog(places[Number(button.dataset.recordVisit)])),
    );
  marketingBindShare($('#marketingRouteBody'), text, null);
}

function marketingVisitDialog(place) {
  const state = marketingRouteState,
    route = state.saved.route,
    manager = ['ceo', 'admin'].includes(hanAuth?.role);
  let dialog = document.getElementById('marketingVisitDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'marketingVisitDialog';
    document.body.append(dialog);
  }
  const now = new Date();
  const today = typeof businessDate === 'function' ? businessDate() : now.toISOString().slice(0, 10);
  // A route searched by province only, or by a drawn region, does not name the district:
  // it is read from the firm's address and the person can correct it.
  const fromAddress = HanMarketingRoute.areaFromAddress(place.address);
  const where = { city: route.city || fromAddress.city, district: route.district || fromAddress.district };
  const askPlace = !route.city || !route.district;
  dialog.innerHTML = `<form id="marketingVisitForm"><div class="panelhead"><h2>Ziyareti Kaydet</h2><button type="button" class="secondary" id="marketingVisitClose">Kapat</button></div>
    <div class="formbody grid">
      <label class="field">Ziyaret sonucu *<select name="visitResult" required><option value="">Sonuç seçin</option>${state.overview.visitResults
        .map((result) => `<option value="${esc(result)}">${esc(result)}</option>`)
        .join('')}</select></label>
      <label class="field">Durum *<select name="status" required><option value="Potansiyel Müvekkil">Potansiyel Müvekkil</option><option value="Mevcut Müvekkil">Mevcut Müvekkil</option></select></label>
      <label class="field">Tarih *<input name="date" type="date" required value="${esc(today)}"></label>
      <label class="field">Saat<input name="time" type="time" value="${String(now.getHours()).padStart(2, '0')}:${String(
        now.getMinutes(),
      ).padStart(2, '0')}"></label>
      ${manager && typeof staffSelect === 'function' ? staffSelect('Personel', 'staffId', hanAuth.staffId || '') : ''}
      <label class="field">Firma adı *<input name="company" required maxlength="200" value="${esc(place.name)}"></label>
      <label class="field">Görüşülen kişi<input name="contact" maxlength="200"></label>
      <label class="field">Telefon<input name="phone" type="tel" maxlength="30" value="${esc(place.phone || '')}"></label>
      ${
        askPlace
          ? `<label class="field">İl *<input name="city" required maxlength="100" value="${esc(where.city)}"></label><label class="field">İlçe *<input name="district" required maxlength="100" value="${esc(where.district)}"></label>`
          : ''
      }
      <label class="field full">Adres<textarea name="address" rows="2" maxlength="1000">${esc(place.address)}</textarea></label>
      <label class="field full">Açıklama<textarea name="notes" rows="3" maxlength="3000"></textarea></label>
    </div><div class="actions"><button class="primary" type="submit">Ziyareti Kaydet</button></div></form>`;
  const form = dialog.querySelector('form');
  dialog.querySelector('#marketingVisitClose').onclick = () => dialog.close();
  form.onsubmit = (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    Object.assign(values, {
      city: askPlace ? String(values.city || '').trim() : route.city,
      district: askPlace ? String(values.district || '').trim() : route.district,
      placeId: place.placeId,
      routeId: route.id,
    });
    try {
      authApi('/api/marketing-prospects', 'POST', values);
      window.modalFormSaved?.(form);
      dialog.close();
      place.visit = {
        status: 'visited',
        result: values.visitResult,
        date: values.date,
        staffName: hanAuth?.name || '',
        own: true,
      };
      state.overviewStale = true;
      marketingSavedRouteDetail();
      toast('Ziyaret kaydedildi.');
    } catch (error) {
      toast(error.message, dialog);
    }
  };
  dialog.showModal();
}

// "Görünen ad | aranacak ifade" lines; a known name keeps its sector ID.
function marketingSectorLines(text, ids) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, ...query] = line.split('|');
      const name = label.trim();
      return {
        id: ids.get(name.toLocaleLowerCase('tr')),
        label: name,
        query: query.join('|').trim() || name,
      };
    });
}

// Ayarlar → Entegrasyonlar → Google Haritalar (CEO only).
function mapsSettingsPage() {
  if (hanAuth?.role !== 'ceo') return toast('Google Haritalar ayarlarını yalnızca CEO yönetebilir.');
  let config;
  try {
    config = authApi('/api/marketing/config');
  } catch (error) {
    return toast(error.message);
  }
  const sectors = config.sectors
    .map((sector) => (sector.query === sector.label ? sector.label : sector.label + ' | ' + sector.query))
    .join('\n');
  // Rota Bulma is sold two ways. `ownKeys` is false for an office that subscribed to the
  // ready map service without buying the module: it has no keys to enter, only sectors.
  const ownKeys = config.ownKeys !== false;
  const ready = [
    ...(config.service ? ['Hazır harita servisi'] : []),
    ...(ownKeys ? (config.sources || []).filter((source) => source.ready).map((source) => source.label) : []),
  ];
  const badge = ready.length ? ready.join(' + ') : 'Kaynak yok';
  const scraperExample = config.allowLocal ? 'http://127.0.0.1:8080' : 'https://tarama.ornek.com';
  const serviceNotice = config.service
    ? `<div class="notice full" id="mapsServiceNotice">Büronuz <b>hazır harita servisine</b> abonedir: firma araması ve harita platformun servisiyle çalışır, API anahtarı girmeniz gerekmez.${
        ownKeys
          ? ' İsterseniz aşağıdan kendi anahtarınızı da bağlayabilirsiniz; Rota Bulma’da kaynağı siz seçersiniz.'
          : ''
      }</div>`
    : '';
  const sectorsField = `<h3 class="full">Sektörler</h3>
      <label class="field full">Sektör listesi<textarea name="sectors" rows="6" required>${esc(
        sectors,
      )}</textarea><small>Her satıra bir sektör yazın: <code>Görünen ad | aranacak ifade</code>. İfade yazılmazsa ad aranır. En fazla 40 sektör. ${
        ownKeys ? 'Tüm kaynaklarda kullanılır.' : 'Rota Bulma’daki sektör seçeneklerini belirler.'
      }</small></label>`;
  if (!ownKeys) {
    $('#content').innerHTML = `${settingsSectionTabs('maps')}<section class="panel">
    <div class="panelhead"><div><h2>Google Haritalar</h2><p>Pazarlama → Rota Bulma’da firma araması.</p></div><span class="badge">${esc(badge)}</span></div>
    <form id="mapsConfigForm"><div class="formbody grid">${serviceNotice}${sectorsField}
    </div><div class="actions"><button class="primary" type="submit">Sektörleri Kaydet</button></div></form>
  </section>`;
    bindSettingsSectionTabs();
    const form = $('#mapsConfigForm');
    const ids = new Map(config.sectors.map((sector) => [sector.label.toLocaleLowerCase('tr'), sector.id]));
    form.onsubmit = (event) => {
      event.preventDefault();
      try {
        authApi('/api/marketing/config', 'PUT', {
          sectors: marketingSectorLines(form.elements.sectors.value, ids),
        });
        window.modalFormSaved?.(form);
        mapsSettingsPage();
        toast('Sektörler kaydedildi.');
      } catch (error) {
        toast(error.message);
      }
    };
    return;
  }
  $('#content').innerHTML = `${settingsSectionTabs('maps')}<section class="panel">
    <div class="panelhead"><div><h2>Google Haritalar</h2><p>Pazarlama → Rota Bulma’da firma araması için kaynaklar: Google Places API ve harita tarama (gosom).</p></div><span class="badge">${esc(badge)}</span></div>
    <form id="mapsConfigForm"><div class="formbody grid">${serviceNotice}
      <label class="field full">Varsayılan kaynak<select name="defaultSource"><option value="google">Google Places API</option><option value="scraper">Harita tarama (gosom)</option></select><small>Rota Bulma’da kullanıcı hazır olan kaynaklar arasından seçebilir; bu, ilk seçili gelendir.</small></label>
      <h3 class="full">1. Google Places API</h3>
      <label class="settings-check full"><input type="checkbox" name="enabled" ${config.enabled && config.apiKeySaved ? 'checked' : ''}> Google Places API ile aramayı aç</label>
      <label class="field full">Google API anahtarı<input name="apiKey" type="password" maxlength="39" autocomplete="new-password" data-optional="true" placeholder="${
        config.apiKeySaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'AIza ile başlayan anahtarı girin'
      }"><small>Anahtar şifrelenerek saklanır, hiçbir kullanıcıya veya tarayıcıya geri gönderilmez ve yedeklere alınmaz.</small></label>
      <label class="settings-check full" ${config.apiKeySaved ? '' : 'hidden'}><input type="checkbox" name="clearApiKey"> Kayıtlı Google API anahtarını sil</label>
      <div class="notice full">${
        config.encryptionReady
          ? 'Anahtar AES-256-GCM ile şifrelenir.'
          : 'Anahtar şifrelemesi bu sunucuda hazır değil. Önce MAPS_ENCRYPTION_KEY veya BACKUP_ENCRYPTION_KEY gizli değişkenini tanımlayın.'
      } Her “Bul” ve “Daha fazla getir” bir Google isteğidir (20 firma). Telefon, puan ve açık/kapalı bilgisi “Text Search Enterprise” tarifesindendir: ayda 1.000 istek ücretsizdir, sonrası Google’ın güncel fiyatıyla ücretlendirilir.</div>
      <div class="full"><button class="secondary" type="button" id="mapsTest">Anahtarı Test Et</button><small id="mapsTestStatus" role="status" aria-live="polite">Test, ücretsiz kimlik-yalnız bir arama gönderir. Girilen anahtar test edilse de kaydedilmez.</small></div>
      <details class="full"><summary>Kurulum</summary><ol>
        <li>Google Cloud Console’da bir proje açın ve faturalandırmayı etkinleştirin.</li>
        <li>API’ler bölümünden <b>Places API (New)</b> hizmetini etkinleştirin.</li>
        <li>Kimlik bilgilerinden bir API anahtarı oluşturun; anahtarı yalnızca Places API (New) ile sınırlayın.</li>
        <li>Kotalar bölümünden günlük istek sınırı koyarak beklenmeyen maliyeti önleyin.</li>
      </ol></details>
      <h3 class="full">2. Harita tarama (gosom)</h3>
      <div class="notice full">Açık kaynak <b>gosom/google-maps-scraper</b> (MIT) sizin bilgisayarınızda veya sunucunuzda çalışır; yazılım ücretsizdir. Google Haritalar’ı taramak Google’ın kullanım koşullarına aykırıdır; yoğun kullanımda Google erişimi engelleyebilir. Firmaların telefonları kişisel veri olabilir (KVKK). Bu kaynağı bu riskleri bilerek açın.</div>
      <label class="settings-check full"><input type="checkbox" name="scraperEnabled" ${config.scraperEnabled ? 'checked' : ''}> Harita tarama ile aramayı aç</label>
      <label class="field full">Tarama sunucusu adresi<input name="scraperUrl" maxlength="300" autocomplete="off" data-optional="true" value="${esc(config.scraperUrl || '')}" placeholder="${esc(scraperExample)}"><small>${
        config.allowLocal
          ? 'Uygulama bu bilgisayarda çalıştığı için http://127.0.0.1:8080 gibi yerel bir adres kullanılabilir.'
          : 'Uygulama bulutta çalıştığı için tarama sunucusuna internetten https:// ile ulaşılmalıdır.'
      }</small></label>
      <label class="field full">Erişim anahtarı (isteğe bağlı)<input name="scraperAuth" type="password" maxlength="500" autocomplete="new-password" data-optional="true" placeholder="${
        config.scraperAuthSaved ? 'Kayıtlı anahtarı korumak için boş bırakın' : 'ör. Basic … veya Bearer …'
      }"><small>Sunucunun önündeki parola korumasına gönderilen <code>Authorization</code> başlığı. Şifrelenerek saklanır ve geri gösterilmez.</small></label>
      <label class="settings-check full" ${config.scraperAuthSaved ? '' : 'hidden'}><input type="checkbox" name="clearScraperAuth"> Kayıtlı erişim anahtarını sil</label>
      <div class="full"><button class="secondary" type="button" id="mapsTestScraper">Tarama Sunucusunu Test Et</button><small id="mapsTestScraperStatus" role="status" aria-live="polite">Test yalnızca sunucuya bağlanır, tarama başlatmaz.</small></div>
      <details class="full"><summary>Kurulum</summary><ol>
        <li>Docker’ı kurun ve tarama sunucusunu başlatın:<br><code>docker run -d --name gmaps -p 127.0.0.1:8080:8080 -v gmapsdata:/gmapsdata -e DISABLE_TELEMETRY=1 gosom/google-maps-scraper -data-folder /gmapsdata</code></li>
        <li>Uygulama bu bilgisayarda çalışıyorsa adres olarak <code>http://127.0.0.1:8080</code> girin.</li>
        <li>Uygulama bulutta çalışıyorsa sunucuyu bir alan adıyla HTTPS ve parola koruması (ör. Caddy veya Nginx) arkasında yayınlayın; parolayı erişim anahtarı olarak girin (<code>Basic …</code>). Sunucuyu korumasız olarak internete açmayın.</li>
      </ol></details>
      <h3 class="full">3. Harita görünümü</h3>
      <label class="field full">Harita anahtarı (isteğe bağlı)<input name="browserKey" maxlength="39" autocomplete="off" data-optional="true" value="${esc(
        config.browserKey || '',
      )}" placeholder="Boş bırakılırsa OpenStreetMap haritası kullanılır"><small>Rota Bulma’da bölge çizdiğiniz haritayı Google haritası yapar ve Google’dan gelen firmaları haritada nokta olarak gösterir. Bu anahtar tarayıcıya gönderilir; Places API anahtarından <b>ayrı</b> bir anahtar oluşturun, yalnızca <b>Maps JavaScript API</b> ile ve sitenizin adresiyle (HTTP yönlendiren) sınırlayın. Anahtar girilmezse harita yine çalışır (OpenStreetMap); Google koşulları gereği o haritada yalnızca harita taramasıyla bulunan firmalar nokta olarak görünür.</small></label>
      ${sectorsField}
    </div><div class="actions"><button class="primary" type="submit">Google Haritalar Ayarlarını Kaydet</button></div></form>
  </section>`;
  bindSettingsSectionTabs();
  const form = $('#mapsConfigForm');
  const ids = new Map(config.sectors.map((sector) => [sector.label.toLocaleLowerCase('tr'), sector.id]));
  form.elements.defaultSource.value = config.defaultSource || 'google';
  // Typing a new key or address means the person wants that source on.
  form.elements.apiKey.addEventListener('input', () => {
    if (form.elements.apiKey.value.trim()) form.elements.enabled.checked = true;
  });
  form.elements.scraperUrl.addEventListener('input', () => {
    if (form.elements.scraperUrl.value.trim()) form.elements.scraperEnabled.checked = true;
  });
  const input = () => ({
    enabled: form.elements.enabled.checked,
    apiKey: form.elements.apiKey.value.trim(),
    clearApiKey: form.elements.clearApiKey.checked,
    scraperEnabled: form.elements.scraperEnabled.checked,
    scraperUrl: form.elements.scraperUrl.value.trim(),
    scraperAuth: form.elements.scraperAuth.value.trim(),
    clearScraperAuth: form.elements.clearScraperAuth.checked,
    defaultSource: form.elements.defaultSource.value,
    browserKey: form.elements.browserKey.value.trim(),
    sectors: marketingSectorLines(form.elements.sectors.value, ids),
  });
  $('#mapsTest').onclick = () => {
    const status = $('#mapsTestStatus');
    status.textContent = 'Test ediliyor…';
    try {
      authApi('/api/marketing/test', 'POST', { apiKey: form.elements.apiKey.value.trim() });
      status.textContent = 'Bağlantı başarılı. Google bu anahtarla aramayı kabul etti.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
  $('#mapsTestScraper').onclick = () => {
    const status = $('#mapsTestScraperStatus');
    status.textContent = 'Test ediliyor…';
    try {
      authApi('/api/marketing/test', 'POST', {
        source: 'scraper',
        scraperUrl: form.elements.scraperUrl.value.trim(),
        scraperAuth: form.elements.scraperAuth.value.trim(),
      });
      status.textContent = 'Bağlantı başarılı. Tarama sunucusu yanıt verdi.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    try {
      authApi('/api/marketing/config', 'PUT', input());
      window.modalFormSaved?.(form);
      mapsSettingsPage();
      toast('Google Haritalar ayarları kaydedildi.');
    } catch (error) {
      toast(error.message);
    }
  };
}

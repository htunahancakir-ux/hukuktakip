const crypto = require('node:crypto');
const route = require('../outputs/icrapro/workspace-marketing-route.js');
const districts = require('../outputs/icrapro/districts.js');
const { normalizePhone } = require('./whatsapp.cjs');
const places = require('./google-places.cjs');

const MAX_ROUTES = 300;
const MAX_STOPS = 60;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const PLAIN_TEXT = /^[^\u0000-\u001f\u007f<>]*$/u;

const failure = (code, message) => Object.assign(new Error(message), { code });
const bad = (message) => failure(400, message);
const isManager = (user) => ['ceo', 'admin'].includes(user?.role);

// Managers, and active personnel in the "Pazarlama" department.
function hasMarketingAccess(state, user) {
  if (!user) return false;
  if (isManager(user)) return true;
  return (state?.data?.['icrapro-personnel-v1'] || []).some(
    (person) =>
      person.id === user.staffId &&
      person.active !== false &&
      String(person.department || '')
        .trim()
        .toLocaleLowerCase('tr-TR') === 'pazarlama',
  );
}

function text(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad(label + ' geçersiz.');
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length > max || !PLAIN_TEXT.test(clean))
    throw bad(label + ' en fazla ' + max + ' karakter olmalıdır.');
  return clean;
}

// A search without a sector looks for firms of every kind.
const ALL_SECTORS = Object.freeze({ id: '', label: 'Tüm firmalar', query: 'firmalar' });

// The area drawn on the map, as [lat, lng] corners rounded to about a metre.
function drawnRegion(value) {
  if (value === undefined || value === null) return null;
  const invalid = () => bad('Haritada çizilen bölge geçersiz. Bölgeyi yeniden çizin.');
  if (!Array.isArray(value) || value.length > route.MAX_REGION_POINTS) throw invalid();
  const points = value.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((n) => typeof n !== 'number')) throw invalid();
    return [Number(pair[0].toFixed(5)), Number(pair[1].toFixed(5))];
  });
  if (!route.validRegion(points)) throw invalid();
  return points;
}

// Only a place is required: a province, or a region drawn on the map. Sector,
// district and the street fields narrow the search when given.
function criteria(input, sectors) {
  const region = drawnRegion(input?.region);
  const city = typeof input?.city === 'string' ? input.city.trim() : '';
  if (city && !Object.hasOwn(districts, city)) throw bad('Listeden bir il seçin.');
  if (!city && !region) throw bad('Bir il seçin veya haritada bir bölge çizin.');
  const district = typeof input.district === 'string' ? input.district.trim() : '';
  if (district && !(city && districts[city].includes(district))) throw bad('Listeden bir ilçe seçin.');
  let sector;
  if (input.sector === 'custom') {
    const query = text(input.customQuery, 80, 'Sektör');
    if (query.length < 2) throw bad('Aranacak sektörü yazın.');
    sector = { id: 'custom', label: query, query };
  } else if (input.sector === undefined || input.sector === null || input.sector === '') sector = ALL_SECTORS;
  else sector = sectors.find((item) => item.id === input.sector);
  if (!sector) throw bad('Bir sektör seçin.');
  return {
    sector: sector.id,
    sectorLabel: sector.label,
    sectorQuery: sector.query,
    customQuery: sector.id === 'custom' ? sector.query : '',
    city,
    district,
    neighborhood: text(input.neighborhood, 80, 'Mahalle'),
    avenue: text(input.avenue, 80, 'Cadde'),
    street: text(input.street, 80, 'Sokak'),
    ...(region ? { region } : {}),
  };
}

// Where the tarama sunucusu opens the map for a drawn region.
function regionGeo(region) {
  const circle = route.regionCircle(region);
  // Fit the region's width into roughly 800 screen pixels.
  const zoom = Math.floor(
    Math.log2((156543 * Math.cos((circle.lat * Math.PI) / 180) * 800) / (2 * circle.radius)),
  );
  return { ...circle, zoom: Math.max(10, Math.min(17, zoom)) };
}

const areaLabel = (c) =>
  [c.neighborhood, c.district, c.city].filter(Boolean).join(' / ') || 'Haritada çizilen bölge';

// "Kızılay" becomes "Kızılay Mahallesi"; typed suffixes and abbreviations stay as written.
function textQuery(c) {
  const suffix = (value, pattern, word) =>
    value && !pattern.test(route.fold(value)) ? value + ' ' + word : value;
  return [
    c.sectorQuery,
    suffix(c.street, /\b(sk|sok|sokak|sokagi)\b/, 'Sokak'),
    suffix(c.avenue, /\b(cd|cad|cadde|caddesi|blv|bulv|bulvar|bulvari)\b/, 'Caddesi'),
    suffix(c.neighborhood, /\b(mh|mah|mahalle|mahallesi)\b/, 'Mahallesi'),
    c.district,
    c.city,
  ]
    .filter(Boolean)
    .join(' ');
}

function pageToken(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value))
    throw bad('Sonraki sayfa bilgisi geçersiz. Aramayı yeniden başlatın.');
  return value;
}

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const component = (place, type) =>
  (place.addressComponents || []).find((item) => Array.isArray(item?.types) && item.types.includes(type))
    ?.longText || '';

function normalizePlace(place) {
  if (typeof place?.id !== 'string' || !PLACE_ID.test(place.id)) return null;
  const lat = Number(place.location?.latitude),
    lng = Number(place.location?.longitude);
  return {
    placeId: place.id,
    name: clip(place.displayName?.text, 200) || 'Adı olmayan işletme',
    address: clip(place.formattedAddress, 400),
    phone: clip(place.nationalPhoneNumber || place.internationalPhoneNumber, 40),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    rating: Number.isFinite(place.rating) ? place.rating : null,
    ratingCount: Number.isSafeInteger(place.userRatingCount) ? place.userRatingCount : 0,
    website:
      typeof place.websiteUri === 'string' && /^https?:\/\//i.test(place.websiteUri)
        ? place.websiteUri.slice(0, 500)
        : '',
    openNow:
      typeof place.currentOpeningHours?.openNow === 'boolean' ? place.currentOpeningHours.openNow : null,
    businessStatus: /^[A-Z_]{1,40}$/.test(place.businessStatus || '') ? place.businessStatus : '',
    city: component(place, 'administrative_area_level_1'),
    district: component(place, 'administrative_area_level_2'),
  };
}

const sameName = (a, b) => {
  const clean = (value) => route.fold(value).replace(/ (ili|ilcesi|province)$/, '');
  return clean(a) === clean(b);
};

// null means Google did not say, or the search did not name one; only a definite
// mismatch is false.
function area(place, c) {
  const inCity = c.city && place.city ? sameName(place.city, c.city) : null;
  let inDistrict = null;
  if (inCity === false) inDistrict = false;
  else if (c.district && place.district)
    inDistrict =
      sameName(place.district, c.district) || (c.district === 'Merkez' && sameName(place.district, c.city));
  return { inCity, inDistrict };
}

const prospectOrder = (item) => (item.date || '') + 'T' + (item.time || '') + '|' + (item.createdAt || '');

// The latest visit wins. Other personnel's names stay hidden from non-managers.
function visitLookup(state, user, district) {
  const manager = isManager(user);
  const byPlace = new Map(),
    byPhone = new Map(),
    byName = new Map(),
    planned = new Map();
  for (const item of [...(state.marketingProspects || [])].sort((a, b) =>
    prospectOrder(a).localeCompare(prospectOrder(b)),
  )) {
    const own = item.createdBy === user.id;
    const summary = {
      status: 'visited',
      result: item.visitResult || '',
      date: item.date || '',
      staffName: manager || own ? item.staffName || '' : '',
      own,
    };
    if (item.placeId) byPlace.set(item.placeId, summary);
    const phone = route.phoneDigits(item.phone);
    if (phone.length >= 10) byPhone.set(phone, summary);
    if (item.company) byName.set(route.fold(item.company) + '|' + route.fold(item.district), summary);
  }
  for (const saved of state.marketingRoutes || [])
    for (const id of saved.stops || [])
      planned.set(id, {
        status: 'planned',
        result: '',
        date: String(saved.createdAt || '').slice(0, 10),
        staffName: manager || saved.createdBy === user.id ? saved.createdByName || '' : '',
        own: saved.createdBy === user.id,
      });
  return (place) => {
    const phone = route.phoneDigits(place.phone);
    // A search without a district matches the name in the firm's own district.
    const where = district || place.district || route.areaFromAddress(place.address).district;
    return (
      byPlace.get(place.placeId) ||
      (phone.length >= 10 ? byPhone.get(phone) : undefined) ||
      (where ? byName.get(route.fold(place.name) + '|' + route.fold(where)) : undefined) ||
      planned.get(place.placeId) ||
      null
    );
  };
}

function annotatePlaces(googlePlaces, c, state, user) {
  const visit = visitLookup(state, user, c.district);
  const result = [];
  let outside = 0;
  for (const raw of googlePlaces) {
    const place = normalizePlace(raw);
    if (!place) continue;
    const { inCity, inDistrict } = area(place, c);
    // Outside the province, or outside the region drawn on the map.
    if (inCity === false || (c.region && !route.pointInRegion(place, c.region))) {
      outside++;
      continue;
    }
    // The district name stays: the screen offers it as a filter.
    const { city, ...shown } = place;
    result.push({
      ...shown,
      district: place.district || route.areaFromAddress(place.address).district,
      inDistrict,
      visit: visit(place),
    });
  }
  return { places: result, outside };
}

function routeSummary(saved, state) {
  const visited = new Set((state.marketingProspects || []).map((item) => item.placeId).filter(Boolean));
  const { requestId, staffId, snapshot, region, ...shown } = saved;
  return {
    ...shown,
    source: saved.source || 'google',
    drawn: Array.isArray(region),
    visitedCount: saved.stops.filter((id) => visited.has(id)).length,
  };
}

function overview(state, user, config) {
  const contact = state.data?.['icrapro-settings-v1']?.contact || {};
  const person = (state.data?.['icrapro-personnel-v1'] || []).find((item) => item.id === user.staffId);
  return {
    ready: config.ready,
    // Labels and readiness only: never the tarama sunucusu address or keys.
    sources: config.sources.map(({ id, label, ready, note }) => ({
      id,
      label,
      ready,
      ...(note ? { note } : {}),
    })),
    defaultSource: config.defaultSource,
    // Which map the screen draws on. A Google map key is a browser key: public by design.
    map: config.map || { provider: 'osm' },
    sectors: config.sectors.map(({ id, label }) => ({ id, label })),
    selfPhone: normalizePhone(user.whatsappPhone || person?.phone || ''),
    office: {
      city: String(contact.city || ''),
      district: String(contact.district || ''),
      address: String(contact.address || ''),
    },
    visitResults: route.VISIT_RESULTS,
    canConfigure: user.role === 'ceo',
    routes: (state.marketingRoutes || [])
      .filter((saved) => isManager(user) || saved.createdBy === user.id)
      .slice(-100)
      .reverse()
      .map((saved) => routeSummary(saved, state)),
  };
}

function saveRoute(state, user, input, sectors) {
  if (typeof input?.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw bad('Geçersiz istek.');
  const existing = (state.marketingRoutes || []).find(
    (saved) => saved.createdBy === user.id && saved.requestId === input.requestId,
  );
  if (existing) return { route: existing, next: null };
  const stops = input.stops;
  if (
    !Array.isArray(stops) ||
    !stops.length ||
    stops.length > MAX_STOPS ||
    stops.some((id) => typeof id !== 'string' || !PLACE_ID.test(id)) ||
    new Set(stops).size !== stops.length
  )
    throw bad('Rotaya 1–' + MAX_STOPS + ' arasında firma ekleyin.');
  const c = criteria(input, sectors);
  const source = ['scraper', 'platform'].includes(input.source) ? input.source : 'google';
  // Google Places content may not be stored (Google Maps terms), so Google routes
  // keep IDs only. Scraped routes keep what the person saw, as there is no paid
  // detail call to refresh them.
  let snapshot;
  if (source === 'scraper') {
    const byId = new Map(
      (Array.isArray(input.places) ? input.places : []).map((place) => [place?.placeId, place]),
    );
    snapshot = stops.map((placeId) => {
      const place = byId.get(placeId);
      if (!place) throw bad('Rotadaki firma bilgileri eksik. Aramayı yenileyip rotayı yeniden oluşturun.');
      const lat = Number(place.lat),
        lng = Number(place.lng);
      const located =
        Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      return {
        placeId,
        name: text(place.name, 200, 'Firma adı') || 'Adı olmayan işletme',
        address: text(place.address, 400, 'Adres'),
        phone: text(place.phone, 40, 'Telefon'),
        lat: located ? lat : null,
        lng: located ? lng : null,
      };
    });
  }
  const mode = ['location', 'office', 'address', 'none'].includes(input.origin?.mode)
    ? input.origin.mode
    : 'none';
  const saved = {
    id: crypto.randomUUID(),
    requestId: input.requestId,
    name:
      text(input.name, 120, 'Rota adı') ||
      c.sectorLabel + ' · ' + ([c.district, c.city].filter(Boolean).join(' / ') || 'Çizilen bölge'),
    createdAt: new Date().toISOString(),
    createdBy: user.id,
    createdByName: user.name || '',
    staffId: user.staffId || '',
    sector: c.sector,
    sectorLabel: c.sectorLabel,
    customQuery: c.customQuery,
    city: c.city,
    district: c.district,
    neighborhood: c.neighborhood,
    avenue: c.avenue,
    street: c.street,
    // The person's own drawing, not map content.
    ...(c.region ? { region: c.region } : {}),
    // Device coordinates are personal data; only the chosen start's label is kept.
    origin: {
      mode,
      label: ['office', 'address'].includes(mode) ? text(input.origin?.label, 200, 'Başlangıç adresi') : '',
    },
    travelMode: input.travelMode === 'walking' ? 'walking' : 'driving',
    source,
    stops: [...stops],
    ...(snapshot ? { snapshot } : {}),
  };
  const next = structuredClone(state);
  next.marketingRoutes = [...(next.marketingRoutes || []), saved].slice(-MAX_ROUTES);
  return { route: saved, next };
}

function findRoute(state, user, routeId) {
  const saved = (state.marketingRoutes || []).find((item) => item.id === routeId);
  if (!saved || (!isManager(user) && saved.createdBy !== user.id)) throw failure(404, 'Rota bulunamadı.');
  return saved;
}

// Google routes refresh names on demand (they are not stored); scraped routes
// return their saved copy without any outside call.
async function routePlaces(state, user, input, { apiKey, fetcher }) {
  const saved = findRoute(state, user, input?.routeId);
  const visit = visitLookup(state, user, saved.district);
  if (saved.source === 'scraper')
    return {
      route: routeSummary(saved, state),
      places: (saved.snapshot || []).map((place) => ({ ...place, visit: visit(place) })),
    };
  if (!apiKey)
    throw failure(
      503,
      saved.source === 'platform'
        ? 'Bu rota hazır harita servisiyle bulundu. Firma adlarını yenilemek için harita servisi aboneliğinizin açık olması gerekiyor.'
        : 'Bu rota Google Places API ile bulundu. Firma adlarını yenilemek için Google Haritalar bağlantısı gerekiyor.',
    );
  const result = [];
  for (let index = 0; index < saved.stops.length; index += 10) {
    const batch = await Promise.all(
      saved.stops.slice(index, index + 10).map(async (placeId) => {
        try {
          const place = normalizePlace(await places.placeDetails({ apiKey, placeId, fetcher })) || {};
          return { ...place, placeId, missing: !place.placeId };
        } catch (error) {
          if (error.code !== 404) throw error;
          return { placeId, missing: true, name: '', address: '', lat: null, lng: null };
        }
      }),
    );
    for (const place of batch) {
      const { city, district, ...shown } = place;
      result.push({ ...shown, visit: visit(place) });
    }
  }
  return { route: routeSummary(saved, state), places: result };
}

module.exports = {
  MAX_ROUTES,
  MAX_STOPS,
  hasMarketingAccess,
  criteria,
  regionGeo,
  areaLabel,
  textQuery,
  pageToken,
  normalizePlace,
  annotatePlaces,
  overview,
  routeSummary,
  saveRoute,
  findRoute,
  routePlaces,
};

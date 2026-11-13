// Client for a self-hosted gosom/google-maps-scraper (MIT) in web/API mode.
// API: POST /api/v1/jobs → {id}; GET /api/v1/jobs/{id} → {Status: pending|working|ok|failed};
// GET /api/v1/jobs/{id}/download → CSV. Scraping Google Maps is against Google's terms;
// the office chooses this source knowingly (see docs/ROTA-BULMA.md).
const { fold, areaFromAddress } = require('../outputs/icrapro/workspace-marketing-route.js');

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
// depth = how far the result list is scrolled; max_time (seconds) caps one job.
const DEPTHS = Object.freeze({
  quick: { depth: 1, maxTime: 300 },
  normal: { depth: 5, maxTime: 600 },
  wide: { depth: 10, maxTime: 1200 },
});
const MAX_CSV_BYTES = 25 * 1024 * 1024;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

async function call(base, path, { method = 'GET', authorization, body, fetcher = fetch, csv = false }) {
  let response;
  try {
    response = await fetcher(base + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(csv ? 30000 : 15000),
      headers: {
        Accept: csv ? 'text/csv' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw failure(
      503,
      'Harita tarama sunucusuna ulaşılamadı. Sunucunun açık olduğunu ve adresini kontrol edin.',
    );
  }
  if ([401, 403, 407].includes(response.status))
    throw failure(503, 'Harita tarama sunucusu erişimi reddetti. Erişim anahtarını kontrol edin.');
  if (response.status === 404)
    throw failure(
      404,
      'Tarama işi bulunamadı. Sunucu yeniden başlatılmış olabilir; aramayı yeniden başlatın.',
    );
  if (response.status === 422) throw failure(400, 'Harita tarama sunucusu arama isteğini kabul etmedi.');
  if (!response.ok)
    throw failure(503, 'Harita tarama sunucusu şu anda yanıt vermiyor. Biraz sonra tekrar deneyin.');
  if (csv) {
    if (Number(response.headers.get('content-length') || 0) > MAX_CSV_BYTES)
      throw failure(503, 'Tarama sonucu çok büyük. Daha dar bir kapsamla yeniden arayın.');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_CSV_BYTES)
      throw failure(503, 'Tarama sonucu çok büyük. Daha dar bir kapsamla yeniden arayın.');
    return text;
  }
  try {
    return await response.json();
  } catch {
    throw failure(503, 'Harita tarama sunucusu beklenmeyen bir yanıt verdi.');
  }
}

// `geo` ({ lat, lng, zoom, radius }) opens the map on a drawn region instead of
// wherever Google places the keywords.
async function createJob({ url, authorization, keywords, depth = 'normal', geo = null, fetcher }) {
  const plan = DEPTHS[depth] || DEPTHS.normal;
  const data = await call(url, '/api/v1/jobs', {
    method: 'POST',
    authorization,
    fetcher,
    body: {
      name: 'Rota Bulma ' + new Date().toISOString(),
      keywords: [keywords],
      lang: 'tr',
      zoom: geo ? geo.zoom : 15,
      ...(geo ? { lat: geo.lat.toFixed(6), lon: geo.lng.toFixed(6), radius: Math.ceil(geo.radius) } : {}),
      depth: plan.depth,
      max_time: plan.maxTime,
      email: false,
      fast_mode: false,
      extra_reviews: false,
    },
  });
  if (typeof data?.id !== 'string' || !JOB_ID.test(data.id))
    throw failure(503, 'Harita tarama sunucusu iş kimliği döndürmedi.');
  return data.id;
}

async function jobStatus({ url, authorization, id, fetcher }) {
  const data = await call(url, '/api/v1/jobs/' + encodeURIComponent(id), { authorization, fetcher });
  return String(data?.Status ?? data?.status ?? '').toLowerCase();
}

async function jobPlaces({ url, authorization, id, fetcher }) {
  const text = await call(url, '/api/v1/jobs/' + encodeURIComponent(id) + '/download', {
    authorization,
    fetcher,
    csv: true,
  });
  return parseCsv(text).map(placeFromRow).filter(Boolean);
}

async function listJobs({ url, authorization, fetcher }) {
  const data = await call(url, '/api/v1/jobs', { authorization, fetcher });
  return Array.isArray(data) ? data.length : 0;
}

// RFC 4180: quoted fields may contain commas, quotes ("") and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  const source = String(text).replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header = [], ...data] = rows.filter((item) => item.some((value) => value !== ''));
  const keys = header.map((name) => name.trim());
  return data.map((values) => Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ''])));
}

function scrapedStatus(value) {
  const text = fold(value);
  if (/kalici olarak kapa|permanently closed/.test(text))
    return { businessStatus: 'CLOSED_PERMANENTLY', openNow: false };
  if (/gecici olarak kapa|temporarily closed/.test(text))
    return { businessStatus: 'CLOSED_TEMPORARILY', openNow: false };
  if (/^(acik|open)|kapanmak uzere|closes soon|24 saat acik/.test(text))
    return { businessStatus: 'OPERATIONAL', openNow: true };
  if (/^(kapali|closed)/.test(text)) return { businessStatus: 'OPERATIONAL', openNow: false };
  return { businessStatus: '', openNow: null };
}

// Same shape as a Places API (New) result, so search annotation stays shared.
function placeFromRow(row) {
  const cid = String(row.cid || '').trim();
  const id = PLACE_ID.test(row.place_id || '') ? row.place_id : /^\d{5,30}$/.test(cid) ? 'cid-' + cid : '';
  if (!id) return null;
  const lat = Number(row.latitude),
    lng = Number(row.longitude);
  const located = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  const rating = Number(row.review_rating),
    reviews = Number(row.review_count);
  const area = areaFromAddress(row.address);
  const status = scrapedStatus(row.status);
  return {
    id,
    displayName: { text: String(row.title || '') },
    formattedAddress: String(row.address || ''),
    nationalPhoneNumber: String(row.phone || ''),
    location: located ? { latitude: lat, longitude: lng } : undefined,
    rating: rating > 0 ? rating : undefined,
    userRatingCount: Number.isSafeInteger(reviews) ? reviews : 0,
    websiteUri: String(row.website || ''),
    businessStatus: status.businessStatus,
    currentOpeningHours: status.openNow === null ? undefined : { openNow: status.openNow },
    addressComponents: [
      ...(area.city ? [{ longText: area.city, types: ['administrative_area_level_1'] }] : []),
      ...(area.district ? [{ longText: area.district, types: ['administrative_area_level_2'] }] : []),
    ],
  };
}

module.exports = {
  DEPTHS,
  JOB_ID,
  createJob,
  jobStatus,
  jobPlaces,
  listJobs,
  parseCsv,
  placeFromRow,
  areaFromAddress,
  scrapedStatus,
};

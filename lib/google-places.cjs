// Google Places API (New). The API key travels only in a request header to Google.
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';
// Phone, rating, website and opening hours are billed as Text Search Enterprise.
const SEARCH_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.businessStatus',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.currentOpeningHours',
  'nextPageToken',
].join(',');
// Saved routes refresh only display fields (Place Details Pro).
const DETAIL_FIELDS = 'id,displayName,formattedAddress,location';
// IDs only: the free Essentials SKU, enough to prove that a key works.
const TEST_FIELDS = 'places.id';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

async function call(url, { method = 'POST', apiKey, fieldMask, body, fetcher = fetch, timeoutMs = 8000 }) {
  let response;
  try {
    response = await fetcher(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw failure(503, 'Google Haritalar’a ulaşılamadı. Biraz sonra tekrar deneyin.');
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (response.ok) return data && typeof data === 'object' ? data : {};
  const detail = data?.error || {};
  const keyProblem =
    [401, 403].includes(response.status) ||
    (detail.details || []).some((item) => /API_KEY/.test(item?.reason || '')) ||
    /api key/i.test(detail.message || '');
  if (keyProblem)
    throw failure(
      503,
      'Google API anahtarı geçersiz, faturalandırma kapalı ya da bu anahtar için Places API (New) etkin değil.',
    );
  if (response.status === 429)
    throw failure(
      429,
      'Google Haritalar kotası doldu. Daha sonra tekrar deneyin veya Google Cloud kotasını artırın.',
    );
  if (response.status === 404) throw failure(404, 'Google Haritalar kaydı bulunamadı.');
  if (response.status === 400)
    throw failure(400, 'Google arama isteğini kabul etmedi. Arama ölçütlerini değiştirip tekrar deneyin.');
  throw failure(503, 'Google Haritalar şu anda yanıt vermiyor. Biraz sonra tekrar deneyin.');
}

// `rectangle` ({ south, west, north, east }) restricts the results to that area.
async function searchText({
  apiKey,
  textQuery,
  pageToken,
  rectangle = null,
  fieldMask = SEARCH_FIELDS,
  pageSize = 20,
  fetcher,
}) {
  const data = await call(SEARCH_URL, {
    apiKey,
    fieldMask,
    fetcher,
    body: {
      textQuery,
      languageCode: 'tr',
      regionCode: 'TR',
      pageSize,
      ...(rectangle
        ? {
            locationRestriction: {
              rectangle: {
                low: { latitude: rectangle.south, longitude: rectangle.west },
                high: { latitude: rectangle.north, longitude: rectangle.east },
              },
            },
          }
        : {}),
      ...(pageToken ? { pageToken } : {}),
    },
  });
  return {
    places: Array.isArray(data.places) ? data.places : [],
    nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : '',
  };
}

async function placeDetails({ apiKey, placeId, fetcher }) {
  return call(DETAILS_URL + encodeURIComponent(placeId) + '?languageCode=tr&regionCode=TR', {
    method: 'GET',
    apiKey,
    fieldMask: DETAIL_FIELDS,
    fetcher,
  });
}

function testKey({ apiKey, fetcher }) {
  return searchText({
    apiKey,
    textQuery: 'hırdavat Çankaya Ankara',
    fieldMask: TEST_FIELDS,
    pageSize: 1,
    fetcher,
  });
}

module.exports = { SEARCH_URL, DETAILS_URL, SEARCH_FIELDS, DETAIL_FIELDS, searchText, placeDetails, testKey };

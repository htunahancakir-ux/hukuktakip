const { createHash } = require('node:crypto');
const { businessDate, validDate } = require('./business-time.cjs');
const fail = (message) => Object.assign(Error(message), { status: 503, publicMessage: true });
const cache = new Map();
function previous(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
function decimalMicros(value) {
  const s = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) throw fail('Kur kaynağından geçerli fiyat alınamadı.');
  const [a, b = ''] = s.split('.'),
    n = BigInt(a) * 1000000n + BigInt((b + '000000').slice(0, 6));
  if (n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('Kur kaynağından geçerli fiyat alınamadı.');
  return Number(n);
}
async function read(url, fetcher) {
  let r;
  try {
    r = await fetcher(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      headers: { Accept: 'application/xml, application/json' },
    });
  } catch {
    throw fail('Günlük kur kaynağına ulaşılamadı. Yeniden deneyin.');
  }
  if (r.status === 404) return null;
  if (!r.ok) throw fail('Günlük kur kaynağı şu anda yanıt vermiyor.');
  const declared = Number(r.headers?.get('content-length') || 0);
  if (declared > 250000) throw fail('Kur kaynağı yanıtı doğrulanamadı.');
  const text = await r.text();
  if (text.length > 250000) throw fail('Kur kaynağı yanıtı doğrulanamadı.');
  return text;
}
function parseTCMB(xml, date, unit) {
  const dateText = xml.match(/<Tarih_Date\b[^>]*\bTarih="(\d{2})\.(\d{2})\.(\d{4})"/);
  if (!dateText || [dateText[3], dateText[2], dateText[1]].join('-') !== date)
    throw fail('TCMB bülten tarihi doğrulanamadı.');
  const row = xml.match(
    new RegExp('<Currency\\b[^>]*CurrencyCode="' + unit + '"[^>]*>([\\s\\S]*?)</Currency>'),
  )?.[1];
  const raw = row?.match(/<ForexSelling>\s*([\d.]+)\s*<\/ForexSelling>/)?.[1],
    count = row?.match(/<Unit>\s*(\d+)\s*<\/Unit>/)?.[1];
  if (!raw || count !== '1') throw fail('TCMB döviz satış kuru doğrulanamadı.');
  return decimalMicros(raw);
}
function parseGold(text, date) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw fail('Altın fiyatı kaynağı doğrulanamadı.');
  }
  if (payload.status !== 'success' || !Array.isArray(payload.data))
    throw fail('Altın fiyatı kaynağı doğrulanamadı.');
  const first = previous(date, 14);
  const rows = payload.data
    .filter(
      (row) =>
        row.priceRef === 'MTL' &&
        row.priceType === 'AU' &&
        row.priceCurrency === 'TRY' &&
        row.priceWeight === 'KG' &&
        validDate(String(row.priceDate).slice(0, 10)) &&
        String(row.priceDate).slice(0, 10) <= date &&
        String(row.priceDate).slice(0, 10) >= first,
    )
    .sort((a, b) => String(b.priceDate).localeCompare(String(a.priceDate)));
  if (!rows.length) throw fail('Seçilen tarihe ait yayımlanmış günlük altın fiyatı bulunamadı.');
  const row = rows[0],
    kgMicros = decimalMicros(row.priceValue),
    gramMicros = Math.round(kgMicros / 1000);
  if (!Number.isSafeInteger(gramMicros) || gramMicros <= 0) throw fail('Gram altın fiyatı doğrulanamadı.');
  return { rateDate: String(row.priceDate).slice(0, 10), rateMicros: gramMicros };
}
async function quote(
  currency,
  date,
  { fetcher = fetch, today = businessDate(), now = Date.now(), cacheStore = cache } = {},
) {
  if (!['EUR', 'USD', 'XAU'].includes(currency) || !validDate(date) || date > today || date < '1996-04-16')
    throw Object.assign(Error('Geçerli birim ve geçmiş veya bugünkü işlem tarihi seçin.'), { status: 400 });
  const key = currency + ':' + date,
    old = cacheStore.get(key);
  if (old && old.expires > now) return old.value;
  let rateMicros, rateDate, source, sourceUrl, sourceHash;
  if (currency === 'XAU') {
    const from = previous(date, 14).replaceAll('-', '/'),
      to = date.replaceAll('-', '/');
    sourceUrl =
      'https://www.borsaistanbul.com/metal-fiyatlari.php?' +
      new URLSearchParams({ op: 'fetchMetalFiyatlari', startDate: from, endDate: to, priceType: 'AU' });
    const raw = await read(sourceUrl, fetcher);
    if (raw === null) throw fail('Günlük gram altın fiyatı bulunamadı.');
    ({ rateMicros, rateDate } = parseGold(raw, date));
    source = 'Borsa İstanbul · 24 ayar saf altın metal fiyatı';
    sourceHash = createHash('sha256').update(raw).digest('hex');
  } else {
    for (let i = 0; i <= 14; i++) {
      const candidate = previous(date, i),
        [y, m, d] = candidate.split('-');
      sourceUrl = 'https://www.tcmb.gov.tr/kurlar/' + y + m + '/' + d + m + y + '.xml';
      const raw = await read(sourceUrl, fetcher);
      if (raw === null) continue;
      rateMicros = parseTCMB(raw, candidate, currency);
      rateDate = candidate;
      sourceHash = createHash('sha256').update(raw).digest('hex');
      break;
    }
    if (!rateMicros) throw fail('Seçilen tarihe ait yayımlanmış TCMB kuru bulunamadı.');
    source = 'TCMB Döviz Satış';
  }
  const value = {
    currency,
    date,
    rateDate,
    rateMicros,
    rate: rateMicros / 1000000,
    source,
    sourceUrl,
    sourceHash,
  };
  value.id = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (cacheStore.size > 4000) cacheStore.clear();
  cacheStore.set(key, { expires: now + 60000, value });
  return value;
}
module.exports = { quote, parseTCMB, parseGold, decimalMicros };

// What an office is called in texts the application writes itself: the suggested staff
// agreement, the test SMS, scheduled reminder messages. The existing office keeps the wording
// it has always had. An office on its own address (`officeName` comes from the console's
// record) is called by the name it entered in Ayarlar → Firma Bilgileri, or else by that
// record's name, and never by another office's.
const LEGACY_ORIGIN = 'https://www.hanhukuktakip.com';
const GENERIC_NAME = 'Hukuk Bürosu';
const clean = (value, max = 180) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

function origin(value, fallback) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : fallback;
  } catch {
    return fallback;
  }
}

function officeIdentity(state, { officeName, appOrigin } = {}) {
  const own = clean(officeName);
  if (!own)
    return {
      legacy: true,
      name: 'Han Hukuk',
      product: 'Han Hukuk Takip',
      software: 'Han Hukuk Takip yazılımında',
      controller: 'Han Hukuk (Av. Hasan Bahadır Patan)',
      incidentContact: 'Av. Hasan Bahadır Patan veya büro yönetimi',
      origin: LEGACY_ORIGIN,
    };
  const firm = state?.data?.['icrapro-settings-v1']?.firm || {};
  const entered = clean(firm.name);
  const name = entered && entered !== GENERIC_NAME ? entered : own;
  const authorized = clean(firm.authorized);
  return {
    legacy: false,
    name,
    product: name,
    software: 'büronun hukuk takip yazılımında',
    controller: clean(firm.legalName) || name,
    incidentContact: authorized ? authorized + ' veya büro yönetimi' : 'büro yönetimi',
    origin: origin(appOrigin, LEGACY_ORIGIN),
  };
}

// SMS without Turkish letters stays in the cheap single-part alphabet.
const plainSms = (text) =>
  String(text)
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => 'cCgGiIoOsSuU'['çÇğĞıİöÖşŞüÜ'.indexOf(c)])
    .replace(/[^\x20-\x7e]/g, '');

module.exports = { officeIdentity, plainSms, LEGACY_ORIGIN };

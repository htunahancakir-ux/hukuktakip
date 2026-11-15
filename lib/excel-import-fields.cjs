const { bad } = require('./excel-workbook.cjs');
const fold = (value) =>
  String(value || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
const f = (key, label, aliases = []) => ({ key, label, aliases: [label, ...aliases] });
const contact = [
  f('identity', 'TC / Vergi No', [
    'TC Kimlik / Vergi Numarası',
    'Vergi No',
    'TC Kimlik No',
    'Borçlu TC',
    'T.C. Kimlik/Mersis No',
  ]),
  f('taxOffice', 'Vergi Dairesi', ['Müvekkil Vergi Dairesi']),
  f('phone', 'Telefon 1', ['Telefon', 'Tel', 'Tel 1', 'Telefon Numaraları']),
  f('phone2', 'Telefon 2'),
  f('phone3', 'Telefon 3'),
  f('phone4', 'Telefon 4'),
  f('phone5', 'Telefon 5'),
  f('address', 'Adres', ['Açık Adres', 'Karşı Yan Adres']),
  f('city', 'İl', ['Karşı Yan İl']),
  f('district', 'İlçe', ['Karşı Yan İlçe']),
  f('notes', 'Açıklama', ['Notlar', 'Not']),
];
const clientFields = [
  f('name', 'Müvekkil Adı', [
    'Alacaklı İsmi',
    'İsim / Ünvan',
    'İsim / Unvan',
    'Firma Adı',
    'Ticari Unvan',
    'Müvekkil',
  ]),
  f('clientCode', 'Müvekkil Kodu', ['Alacaklı Kodu', 'Kod']),
  f('type', 'Kişi Türü', ['Gerçek / Tüzel', 'Şahıs / Şirket']),
  f('category', 'Müvekkil Türü', ['Sektör']),
  ...contact,
  f('identityClient', 'Müvekkil Vergi No'),
  f('mersisNumber', 'MERSİS No', ['Müvekkil T.C. Kimlik / Mersis No']),
  f('email', 'E-posta', ['E.Posta 1', 'E Posta']),
  f('iban', 'IBAN', ['Müvekkil Banka Hesap No', 'Banka Hesap No']),
  f('bankName', 'Banka', ['Müvekkil Banka', 'Banka Adı']),
  f('bankBranch', 'Banka Şubesi', ['Müvekkil Banka Şubesi', 'Şube']),
  f('accountHolder', 'Hesap Sahibi'),
  f('documentStaff', 'Evrakı Alan Personel', ['Evrak Alan Personel']),
  f('recordedBy', 'Evrakı Kaydeden'),
  f('sourceFolio', 'Kaynak Föy No', ['Föy No']),
];
const documentFields = [
  f('debtor', 'Borçlu Adı', ['Borçlu', 'Borçlu Ad Soyad / Unvan', 'Karşı Yan İsmi']),
  f('clientName', 'Müvekkil Adı', ['Alacaklı İsmi', 'Müvekkil']),
  f('clientIdentity', 'Müvekkil Vergi No'),
  f('clientCode', 'Müvekkil Kodu', ['Alacaklı Kodu']),
  f('debtorType', 'Borçlu Türü'),
  ...contact,
  f('sourceFolio', 'Kaynak Föy No', ['Föy No']),
  f('docType', 'Evrak Türü', ['Evrak Cinsi', 'Alacak Türü', 'Tür']),
  f('gross', 'Evrak Tutarı', ['Alacak Miktarı', 'Alacak Tutarı', 'Toplam Evrak Tutarı']),
  f('amount', 'Asıl Alacak', ['Anapara', 'Tutar']),
  f('preTrackingPayment', 'Takip Öncesi Ödeme'),
  f('currency', 'Para Birimi', ['Döviz Cinsi', 'PB']),
  f('due', 'Vade Tarihi', ['Alacak Tarihi', 'Vade']),
  f('registeredOn', 'Kayıt Tarihi', ['Takip Tarihi']),
  f('issued', 'Düzenleme Tarihi'),
  f('serial', 'Evrak Numarası', ['Senet Numarası', 'Çek Numarası']),
  f('receivedBy', 'Evrakı Alan Personel', ['Evrak Alan', 'Evrakı Alan', 'Evrak Alan Personel']),
  f('recordedBy', 'Evrakı Kaydeden'),
  f('responsible', 'Dosya Sorumlusu', ['Sorumlu']),
  f('enforcementOffice', 'İcra Müdürlüğü', ['İcra Dairesi']),
  f('enforcementFileNumber', 'İcra Dosya Numarası'),
  f('icramatikFolioNumber', 'İcramatik Föy No'),
  f('financeInterest', 'İşlemiş Faiz', ['Faiz']),
  f('financeFee', 'Avukatlık Ücreti', ['Vekalet Ücreti']),
  f('status', 'Dosya Durumu', ['Durum']),
  f('parkingEntry', 'Men Tarihi', ['Otoparka Giriş Tarihi']),
  f('vehicleKind', 'Araç Cinsi'),
  f('vehiclePlate', 'Plaka'),
  f('parkingName', 'Otopark Adı'),
  f('parkingCommissionRate', 'Anlaşılan %', ['Ofis Payı']),
  f('paymentAmount', 'Tahsilat Tutarı', ['Ödenen Tutar', 'Ödenen', 'Borçlu Ödeme Tutarı']),
  f('paymentDate', 'Tahsilat Tarihi', ['Ödeme Tarihi', 'Borçlu Ödeme Tarihi']),
  f('paymentBank', 'Tahsilat Bankası', ['Paranın Girdiği Kasa / Banka', 'Kasa / Banka', 'Hesap']),
  f('turnoverStaff', 'Ciro Personeli'),
];
const fields = (kind) => (kind === 'clients' ? clientFields : documentFields);
function describe(sheet, kind) {
  const defs = fields(kind);
  let header = sheet.rows[0],
    score = -1;
  for (const row of sheet.rows.slice(0, 10)) {
    const count = Object.values(row.cells).filter((v) =>
      defs.some((f) => f.aliases.some((a) => fold(a) === fold(v))),
    ).length;
    if (count > score) {
      score = count;
      header = row;
    }
  }
  if (!header) throw bad('Seçilen Excel sayfası boş.');
  if (Object.values(header.cells).some((v) => v.length > 200))
    throw bad('Excel sütun başlıkları en fazla 200 karakter olabilir.');
  const columns = Object.entries(header.cells).map(([key, label]) => ({ key, label }));
  const mapping = {};
  for (const field of defs) {
    const found = columns.find((c) => field.aliases.some((a) => fold(a) === fold(c.label)));
    mapping[field.key] = found?.key || '';
  }
  return {
    name: sheet.name,
    headerRow: header.row,
    columns,
    mapping,
    rowCount: sheet.rows.filter((r) => r.row > header.row).length,
  };
}
function mapped(sheet, kind, mapping) {
  const description = describe(sheet, kind),
    known = new Set(fields(kind).map((f) => f.key));
  const map = mapping || description.mapping;
  if (
    !map ||
    typeof map !== 'object' ||
    Array.isArray(map) ||
    Object.entries(map).some(
      ([k, v]) =>
        !known.has(k) || typeof v !== 'string' || (v && !description.columns.some((c) => c.key === v)),
    )
  )
    throw bad('Sütun eşleştirmesi geçersiz.');
  return sheet.rows
    .filter((r) => r.row > description.headerRow)
    .map((row) => ({
      key: sheet.name + ':' + row.row,
      sheet: sheet.name,
      row: row.row,
      values: Object.fromEntries(
        fields(kind).map((f) => [f.key, map[f.key] ? String(row.cells[map[f.key]] || '').trim() : '']),
      ),
      sources: [{ sheet: sheet.name, row: row.row }],
    }));
}
function importRows(sheets, input) {
  if (!['clients', 'documents'].includes(input.kind)) throw bad('Aktarım türü geçersiz.');
  const selected =
    sheets.find((s) => s.name === input.sheet) ||
    (!input.sheet
      ? sheets.find(
          (s) =>
            s.rows.length && describe(s, input.kind).mapping[input.kind === 'clients' ? 'name' : 'debtor'],
        )
      : null) ||
    (!input.sheet ? sheets[0] : null);
  if (!selected) throw bad('Excel sayfasını seçin.');
  const rows = mapped(selected, input.kind, input.mapping);
  if (input.kind === 'clients' && input.mergeSheets !== false) {
    const others = sheets.filter((s) => s !== selected && s.rows.length).flatMap((s) => mapped(s, 'clients'));
    for (const row of rows)
      for (const other of others) {
        const a = row.values,
          b = other.values;
        if (
          !a.clientCode ||
          fold(a.clientCode) !== fold(b.clientCode) ||
          !a.name ||
          fold(a.name) !== fold(b.name)
        )
          continue;
        const identityA = a.identityClient || a.identity,
          identityB = b.identityClient || b.identity;
        if (identityA && identityB && identityA !== identityB)
          throw bad('Aynı müvekkil kodunda farklı vergi numaraları var.');
        for (const [key, value] of Object.entries(b)) if (!a[key] && value) a[key] = value;
        row.sources.push(...other.sources);
      }
  }
  if (rows.length > 500) throw bad('Bir aktarımda en fazla 500 satır seçilebilir.');
  return { selected: selected.name, rows };
}
function amount(value, label, { optional = false } = {}) {
  if (!String(value || '').trim()) {
    if (optional) return 0;
    throw bad(label + ' gerekli.');
  }
  let text = String(value).trim().replace(/[₺\s]/g, '');
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  if (!/^\d+(\.\d{1,3})?$/.test(text)) throw bad(label + ' geçerli bir sayı olmalıdır.');
  const valueNumber = Number(text);
  if (!Number.isFinite(valueNumber) || !Number.isSafeInteger(Math.round(valueNumber * 1000)))
    throw bad(label + ' çok büyük.');
  return valueNumber;
}
function date(value, label, { optional = false } = {}) {
  if (!value && optional) return '';
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  const result = match ? match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0') : text;
  if (!require('./business-time.cjs').validDate(result)) throw bad(label + ' geçerli bir tarih olmalıdır.');
  return result;
}
module.exports = { fields, describe, importRows, amount, date, fold };

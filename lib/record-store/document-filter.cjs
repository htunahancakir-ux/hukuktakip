const { validDate } = require('../business-time.cjs');
const { createHash } = require('node:crypto');
const invalid = (message) => Object.assign(Error(message), { status: 400 });
const normalize = (value) =>
  String(value ?? '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
const like = (value) => '%' + normalize(value).replace(/[\\%_]/g, '\\$&') + '%';
const folioPattern = (value) => {
  const match = normalize(value).match(/^([a-z]+)-0*([0-9]+)$/);
  return match ? '^' + match[1] + '-0*' + match[2] + '$' : null;
};
const sorts = Object.freeze({
  id: { expression: 'd.id', direction: 'ASC' },
  entryOrder: { expression: 'd.ordinal', direction: 'ASC' },
  trackingAsc: { expression: "coalesce(nullif(d.tracking_on,''),'9999-99-99')", direction: 'ASC' },
  trackingDesc: { expression: "coalesce(d.tracking_on,'')", direction: 'DESC' },
});
const displayDate = (column) =>
  `substring(${column} FROM 9 FOR 2)||'/'||substring(${column} FROM 6 FOR 2)||'/'||left(${column},4)`;
const phoneSql = (
  p,
) => `EXISTS(SELECT 1 FROM unnest(d.phone_values) AS phone(value) WHERE strpos(value,${p})>0
 OR (left(${p},2)='90' AND strpos(regexp_replace(value,'^0',''),substring(${p} FROM 3))>0)
 OR (left(${p},1)='0' AND strpos(regexp_replace(regexp_replace(value,'^90',''),'^0',''),substring(${p} FROM 2))>0))`;
function filter(input, { manager = true } = {}) {
  const limit = Number(input.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('Sayfa boyutu 1–100 olmalı.');
  const sort = input.sort || 'id';
  if (!Object.hasOwn(sorts, sort)) throw invalid('Geçersiz sıralama.');
  const params = [],
    conditions = ['d.active'];
  const bind = (value) => '$' + params.push(value);
  const text = (name) => {
    if (input[name] == null || input[name] === '') return '';
    if (typeof input[name] !== 'string' || input[name].length > 160) throw invalid('Geçersiz filtre.');
    return input[name].trim();
  };
  const contains = (column, value, number = false) => {
    if (!value) return;
    let clause = `han_data.search_normalize(${column}) LIKE ${bind(like(value))} ESCAPE '\\'`;
    const pattern = number && folioPattern(value);
    if (pattern) clause = '(' + clause + ' OR han_data.search_normalize(d.number) ~ ' + bind(pattern) + ')';
    conditions.push(clause);
  };
  for (const [name, column] of [
    ['client', 'd.client_id'],
    ['staff', 'd.staff_id'],
    ['type', 'd.kind'],
  ]) {
    const value = text(name);
    if (!value || value === 'Tümü') continue;
    if (name === 'staff' && value === 'unassigned') conditions.push('d.staff_id IS NULL');
    else conditions.push(column + '=' + bind(value));
  }
  for (const [name, column] of [
    ['dueStart', 'd.due_on'],
    ['dueEnd', 'd.due_on'],
    ['trackingStart', 'd.tracking_on'],
    ['trackingEnd', 'd.tracking_on'],
  ]) {
    const value = text(name);
    if (!value) continue;
    if (!validDate(value)) throw invalid('Geçersiz tarih.');
    conditions.push(column + (name.endsWith('Start') ? '>=' : '<=') + bind(value));
  }
  for (const [start, end] of [
    ['dueStart', 'dueEnd'],
    ['trackingStart', 'trackingEnd'],
  ])
    if (input[start] && input[end] && input[start] > input[end]) throw invalid('Tarih aralığı ters olamaz.');
  for (const name of ['minCents', 'maxCents']) {
    if (input[name] === '' || input[name] == null) continue;
    if (!/^\d{1,18}$/.test(String(input[name]))) throw invalid('Geçersiz tutar.');
    conditions.push(
      (manager ? 'b.target_cents' : 'b.principal_cents') +
        (name === 'minCents' ? '>=' : '<=') +
        bind(String(input[name])) +
        '::bigint',
    );
  }
  if (input.minCents && input.maxCents && BigInt(input.minCents) > BigInt(input.maxCents))
    throw invalid('Tutar aralığı ters olamaz.');
  for (const [name, column] of [
    ['number', 'd.number'],
    ['debtor', "d.body->>'debtor'"],
    ['identity', "d.body->>'identity'"],
    ['enforcementOffice', "d.body->>'enforcementOffice'"],
    ['enforcementFileNumber', "d.body->>'enforcementFileNumber'"],
  ])
    contains(column, text(name), name === 'number');
  const phone = text('phone').replace(/\D/g, '');
  if (phone) conditions.push(phoneSql(bind(phone)));
  const query = text('query');
  if (query) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const clauses = terms.map((term) => {
      const p = bind(like(term));
      const pattern = folioPattern(term);
      const numberClause = pattern ? ' OR han_data.search_normalize(d.number) ~ ' + bind(pattern) : '';
      return `(d.search_text LIKE ${p} ESCAPE '\\' OR c.search_text LIKE ${p} ESCAPE '\\'${numberClause}
        OR han_data.search_normalize(d.kind) LIKE ${p} ESCAPE '\\'
        OR EXISTS(SELECT 1 FROM han_data.personnel ps WHERE ps.active AND ps.id IN (c.body->>'documentStaff',c.body->>'collectionStaff')
          AND han_data.search_normalize(ps.body->>'name') LIKE ${p} ESCAPE '\\'))`;
    });
    let clause = '(' + clauses.join(' AND ') + ')';
    const digits = query.replace(/\D/g, '');
    if (/^[+\d\s().-]+$/.test(query) && digits.length >= 3)
      clause = '(' + clause + ' OR ' + phoneSql(bind(digits)) + ')';
    conditions.push(clause);
  }
  const statusConditions = [...conditions];
  const statusParams = [...params];
  const status = text('status');
  if (status && status !== 'Tümü') conditions.push('d.status=' + bind(status));
  for (const [name, column] of [
    ['columnRecord', "concat_ws(' ',d.number,d.kind,c.name)"],
    ['columnDebtor', "d.body->>'debtor'"],
    ['columnStaff', "coalesce(nullif(p.body->>'name',''),nullif(d.body->>'relatedStaffName',''),'Atanmadı')"],
    [
      'columnAmount',
      "translate(to_char(b.principal_cents/100.0,'FM999,999,999,999,990.00'),',.','.,')||' TL'",
    ],
    ['columnTracking', displayDate('d.tracking_on')],
    ['columnDue', displayDate('d.due_on')],
    ['columnClosure', displayDate('b.closed_on')],
  ]) {
    const value = text(name);
    contains(column, value, name === 'columnRecord');
  }
  if (text('columnType')) conditions.push('d.kind=' + bind(text('columnType')));
  const signature = createHash('sha256')
    .update(JSON.stringify({ conditions, params, sort }))
    .digest('hex')
    .slice(0, 24);
  let cursor = null;
  if (input.after) {
    if (typeof input.after !== 'string' || input.after.length > 1200) throw invalid('Geçersiz sayfa.');
    if (sort === 'id' && !input.after.startsWith('page:')) cursor = { id: input.after, value: input.after };
    else {
      try {
        cursor = JSON.parse(Buffer.from(input.after.slice(5), 'base64url'));
      } catch {
        throw invalid('Geçersiz sayfa.');
      }
      if (
        !input.after.startsWith('page:') ||
        cursor.signature !== signature ||
        typeof cursor.id !== 'string' ||
        typeof cursor.value !== 'string'
      )
        throw invalid('Filtre değişti; ilk sayfadan başlayın.');
      if (sort === 'entryOrder' && !/^\d{1,18}$/.test(cursor.value)) throw invalid('Geçersiz sayfa.');
    }
  }
  return { limit, params, conditions, statusConditions, statusParams, sort, cursor, signature };
}
function pageOrder(f, params, conditions) {
  const { expression, direction } = sorts[f.sort],
    operator = direction === 'ASC' ? '>' : '<';
  if (f.cursor) {
    if (f.sort === 'id') conditions.push('d.id>' + '$' + params.push(f.cursor.id));
    else {
      const first = '$' + params.push(f.cursor.value),
        second = '$' + params.push(f.cursor.id);
      conditions.push(`(${expression},d.id)${operator}(${first},${second})`);
    }
  }
  return { expression, order: expression + ' ' + direction + (f.sort === 'id' ? '' : ',d.id ' + direction) };
}
function nextCursor(f, row) {
  return f.sort === 'id'
    ? row.id
    : 'page:' +
        Buffer.from(JSON.stringify({ id: row.id, value: row.sortValue, signature: f.signature })).toString(
          'base64url',
        );
}
module.exports = { filter, pageOrder, nextCursor, normalize };

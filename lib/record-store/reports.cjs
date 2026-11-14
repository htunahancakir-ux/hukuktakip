const { createHash } = require('node:crypto');
const { actor } = require('./queries.cjs');
const { inTransaction } = require('../db-transaction.cjs');
const { businessDate, validDate } = require('../business-time.cjs');
const { refreshBalances, calculationVersion } = require('./balances.cjs');
const { source } = require('./report-sql.cjs');
const definitions = require('../../outputs/icrapro/report-definitions.js');
const failure = (message) => Object.assign(Error(message), { status: 400 });
const balanceTypes = new Set(['documents', 'clientDebtorInfo', 'installments']);

function filters(input = {}) {
  const type = input.type || 'finance';
  if (!Object.hasOwn(definitions, type)) throw failure('Rapor türü geçersiz.');
  const f = { type };
  for (const key of [
    'from',
    'to',
    'client',
    'staff',
    'status',
    'account',
    'query',
    'receiver',
    'documentType',
  ]) {
    f[key] = input[key] ?? '';
    if (typeof f[key] !== 'string' || f[key].length > (key === 'query' ? 200 : 160))
      throw failure('Geçersiz rapor filtresi.');
  }
  if (type !== 'hanDocuments' && (f.receiver || f.documentType))
    throw failure('Evrak filtreleri yalnızca Evrak Raporunda kullanılabilir.');
  for (const key of ['from', 'to'])
    if (f[key] && !validDate(f[key])) throw failure('Geçerli rapor tarihi seçin.');
  if (f.from && f.to && f.from > f.to) throw failure('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  if (input.undated !== undefined && ![true, false, 'true', 'false'].includes(input.undated))
    throw failure('Geçersiz tarih seçimi.');
  f.undated = input.undated !== false && input.undated !== 'false';
  f.limit = Number(input.limit ?? 50);
  if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > 100) throw failure('Geçersiz sayfa boyutu.');
  f.signature = createHash('sha256').update(JSON.stringify(f)).digest('hex');
  if (input.after) {
    try {
      if (typeof input.after !== 'string' || input.after.length > 2000) throw Error();
      f.cursor = JSON.parse(Buffer.from(input.after, 'base64url'));
      if (
        f.cursor.signature !== f.signature ||
        typeof f.cursor.id !== 'string' ||
        f.cursor.id.length > 500 ||
        typeof f.cursor.order !== 'string' ||
        f.cursor.order.length > 500
      )
        throw Error();
    } catch {
      throw failure('Sayfa bilgisi geçersiz; ilk sayfadan başlayın.');
    }
  }
  return f;
}
function query(f, today) {
  const { cte, sql } = source(f.type),
    params = [today],
    conditions = [];
  const bind = (value) => '$' + params.push(value);
  const dates = [];
  if (f.from) dates.push('date>=' + bind(f.from));
  if (f.to) dates.push('date<=' + bind(f.to));
  conditions.push(
    `((date<>''${dates.length ? ' AND ' + dates.join(' AND ') : ''})${f.undated ? " OR date=''" : ''})`,
  );
  for (const [key, column] of [
    ['client', 'client_id'],
    ['staff', 'staff_id'],
    ['status', 'status'],
    ['account', 'account_id'],
  ])
    if (f[key]) conditions.push(column + '=' + bind(f[key]));
  if (f.query)
    conditions.push(
      `strpos(han_data.search_normalize((SELECT string_agg(coalesce(value,''),' ') FROM jsonb_each_text(cells))),han_data.search_normalize(${bind(f.query)}))>0`,
    );
  if (f.receiver) conditions.push("cells->>'receiverId'=" + bind(f.receiver));
  if (f.documentType) conditions.push("cells->>'type'=" + bind(f.documentType));
  const order =
    f.type === 'clientList'
      ? "han_data.search_normalize(coalesce(nullif(cells->>'name',''),cells->>'tradeName',''))"
      : 'date';
  return {
    params,
    cte: `WITH settings AS (SELECT $1::text AS today),${cte ? cte + ',' : ''} report_rows AS (${sql}), filtered AS (SELECT *,${order} AS sort_value FROM report_rows WHERE ${conditions.join(' AND ')})`,
    direction: f.type === 'clientList' ? 'ASC' : 'DESC',
  };
}
function totalsSQL(type) {
  const fields = definitions[type].columns
    .filter((c) => ['money', 'count'].includes(c[2]))
    .flatMap(([key]) => [`'${key}'`, `coalesce(sum((cells->>'${key}')::numeric),0)::text`]);
  return `SELECT count(*)::text AS count,count(*) FILTER(WHERE date='')::text AS undated,jsonb_build_object(${fields.join(',')}) AS totals FROM filtered`;
}
async function prepare(pool, req, f) {
  const user = await actor(pool, req);
  if (['staffBreaks', 'staffAttendance'].includes(f.type) && !['ceo', 'admin'].includes(user.role))
    throw Object.assign(Error('Personel zaman raporlarını yalnızca yönetici görebilir.'), { status: 403 });
  if (balanceTypes.has(f.type)) await refreshBalances(pool, businessDate());
}
async function ready(db, req, f, today) {
  const user = await actor(db, req);
  if (['staffBreaks', 'staffAttendance'].includes(f.type) && !['ceo', 'admin'].includes(user.role))
    throw Object.assign(Error('Personel zaman raporlarını yalnızca yönetici görebilir.'), { status: 403 });
  if (balanceTypes.has(f.type)) {
    const stale = await db.query(
      `SELECT 1 FROM han_data.documents d LEFT JOIN han_data.document_balances b ON b.document_id=d.id
      WHERE d.active AND (b.document_id IS NULL OR b.source_revision<>d.revision OR b.valid_until<$1 OR b.calculation_version<>$2) LIMIT 1`,
      [today, calculationVersion],
    );
    if (stale.rows.length)
      throw Object.assign(Error('Toplamlar güncelleniyor. Raporu yeniden açın.'), { status: 409 });
  }
}
async function reportPage(pool, req, input = {}) {
  const f = filters(input),
    today = businessDate();
  await prepare(pool, req, f);
  return inTransaction(
    pool,
    async (db) => {
      await ready(db, req, f, today);
      const q = query(f, today);
      const {
        rows: [totals],
      } = await db.query(q.cte + ' ' + totalsSQL(f.type), q.params);
      const params = [...q.params];
      const cursor = f.cursor
        ? `WHERE (sort_value,id)${q.direction === 'ASC' ? '>' : '<'}($${params.push(f.cursor.order)},$${params.push(f.cursor.id)})`
        : '';
      const { rows } = await db.query(
        q.cte +
          ` SELECT id,date,client_id AS "clientId",staff_id AS "staffId",status,account_id AS "accountId",document_id AS "documentId",cells,sort_value FROM filtered ${cursor} ORDER BY sort_value ${q.direction},id ${q.direction} LIMIT $${params.push(f.limit + 1)}`,
        params,
      );
      const last = rows[f.limit - 1];
      return {
        ...totals,
        items: rows.slice(0, f.limit).map(({ sort_value, ...row }) => row),
        next:
          rows.length > f.limit
            ? Buffer.from(
                JSON.stringify({ signature: f.signature, order: last.sort_value, id: last.id }),
              ).toString('base64url')
            : null,
        calculatedOn: today,
      };
    },
    { readOnly: true },
  );
}
const html = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function money(value) {
  const n = BigInt(value || 0),
    absolute = n < 0n ? -n : n;
  return (
    (n < 0n ? '-' : '') +
    (absolute / 100n).toLocaleString('tr-TR') +
    ',' +
    String(absolute % 100n).padStart(2, '0') +
    ' TL'
  );
}
const csv = (value) => {
  let s = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
const shownDate = (day) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day.slice(8) + '/' + day.slice(5, 7) + '/' + day.slice(0, 4)
    : day || 'Tarih yok';
function cell(row, column, def, format) {
  const value = row.cells[column[0]];
  if (column[2] !== 'money') return String(value ?? '—');
  if (format === 'csv' && def.dateHeader) {
    const n = BigInt(value || 0),
      absolute = n < 0n ? -n : n;
    return (n < 0n ? '-' : '') + String(absolute / 100n) + ',' + String(absolute % 100n).padStart(2, '0');
  }
  return money(value);
}
// An explicit export streams the complete selection from one repeatable-read
// snapshot. It never exports just the visible page or buffers the full workspace.
async function reportExport(pool, req, input = {}) {
  const f = filters({ ...input, after: '' }),
    format = input.format || 'csv',
    def = definitions[f.type],
    today = businessDate();
  if (!['csv', 'html'].includes(format)) throw failure('Geçersiz çıktı biçimi.');
  await prepare(pool, req, f);
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
    await ready(db, req, f, today);
    const q = query(f, today);
    if (f.type === 'clientDebtorInfo') {
      const pending = await db.query(
        q.cte + " SELECT 1 FROM filtered WHERE cells->>'reportPending'='true' LIMIT 1",
        q.params,
      );
      if (pending.rows.length)
        throw Object.assign(Error('Görüşme özetleri henüz tamamlanmadı. Raporu açıp tekrar deneyin.'), {
          status: 409,
        });
    }
    const {
      rows: [totals],
    } = await db.query(q.cte + ' ' + totalsSQL(f.type), q.params);
    await db.query(
      `DECLARE report_export NO SCROLL CURSOR FOR ${q.cte} SELECT date,cells FROM filtered ORDER BY sort_value ${q.direction},id ${q.direction}`,
      q.params,
    );
    async function* chunks() {
      let done = false;
      try {
        const headings = [
          ...(def.hideDate ? [] : [def.dateHeader || 'Tarih']),
          ...def.columns.map((c) => c[1]),
        ];
        if (format === 'csv') yield '\uFEFF' + headings.map(csv).join(';') + '\r\n';
        else
          yield `<!doctype html><html lang="tr"><meta charset="utf-8"><title>${html(def.label)}</title><style>body{font:11px Arial;color:#182b3a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left;white-space:pre-line;overflow-wrap:anywhere}thead{display:table-header-group}th{background:#eef2f5}@page{size:A4 landscape;margin:10mm}</style><h1>Han Hukuk · ${html(def.label)}</h1><p>${html(f.from ? shownDate(f.from) : 'Başlangıç yok')} – ${html(f.to ? shownDate(f.to) : 'Bitiş yok')} · ${html(totals.count)} kayıt · ${html(shownDate(today))}</p><table><thead><tr>${headings.map((h) => '<th>' + html(h) + '</th>').join('')}</tr></thead><tbody>`;
        for (;;) {
          const { rows } = await db.query('FETCH FORWARD 500 FROM report_export');
          if (!rows.length) break;
          yield rows
            .map((r) => {
              const values = [
                ...(def.hideDate ? [] : [shownDate(r.date)]),
                ...def.columns.map((c) => cell(r, c, def, format)),
              ];
              return format === 'csv'
                ? values.map(csv).join(';') + '\r\n'
                : '<tr>' + values.map((v) => '<td>' + html(v) + '</td>').join('') + '</tr>';
            })
            .join('');
        }
        if (format === 'html')
          yield '</tbody><tfoot><tr>' +
            (!def.hideDate ? '<th>TOPLAM</th>' : '') +
            def.columns
              .map(
                (c, i) =>
                  '<th>' +
                  (c[2] === 'money'
                    ? html(money(totals.totals[c[0]]))
                    : c[2] === 'count'
                      ? html(BigInt(totals.totals[c[0]] || '0').toLocaleString('tr-TR'))
                      : def.hideDate && i === 0
                        ? 'TOPLAM'
                        : '') +
                  '</th>',
              )
              .join('') +
            '</tr></tfoot></table></html>';
        await db.query('COMMIT');
        done = true;
      } finally {
        if (!done) await db.query('ROLLBACK').catch(() => {});
        db.release();
      }
    }
    return { chunks: chunks(), format, filename: 'hanhukuk-' + f.type + '-' + today + '.' + format };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
    throw error;
  }
}

async function insReport(pool, req, { from = businessDate(), to = from } = {}) {
  if (!validDate(from) || !validDate(to) || from > to) throw failure('Geçerli tarih aralığı seçin.');
  return inTransaction(
    pool,
    async (db) => {
      await actor(db, req);
      const { rows } = await db.query(
        `WITH categories AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS c(id text,name text,key text)),raw_events AS (
      SELECT e.*,coalesce(nullif(e.body->>'turnoverStaffId',''),nullif(e.body->>'collectionStaffId',''),d.staff_id,'unassigned') AS staff,
        coalesce(nullif(e.body->>'turnoverStaffName',''),nullif(e.body->>'collectionStaffName',''),d.body->>'relatedStaffName','Personel atanmamış') AS name
      FROM han_data.financial_events e LEFT JOIN han_data.documents d ON d.id=e.document_id AND d.active
      WHERE e.active AND e.kind='payment' AND left(e.occurred_on,10)>=$1 AND left(e.occurred_on,10)<=$2
    ), events AS (SELECT r.id,r.document_id,r.amount_cents,r.body,r.ordinal,coalesce(c.id,r.staff) AS staff,coalesce(c.name,r.name) AS name FROM raw_events r
      LEFT JOIN han_data.personnel source ON source.id=r.staff
      LEFT JOIN categories c ON c.id=r.staff OR (NOT EXISTS(SELECT 1 FROM categories known WHERE known.id=r.staff) AND c.key=regexp_replace(replace(lower(translate(coalesce(source.body->>'name',r.name),'Iİ','ıi')),'ı','i'),'[[:space:]_-]','','g'))
    ), collections AS (SELECT staff,sum(amount_cents) AS collected,(array_agg(name ORDER BY ordinal,id))[1] AS name FROM events GROUP BY staff),
    closed AS (SELECT DISTINCT ON(staff,coalesce(nullif(document_id,''),id)) staff,
      coalesce(nullif((body->>'closedAmount')::numeric,0),amount_cents,0) AS amount FROM events WHERE body->>'closes'='true' ORDER BY staff,coalesce(nullif(document_id,''),id),ordinal,id),
    closures AS (SELECT staff,count(*) AS count,sum(amount) AS amount FROM closed GROUP BY staff),
    people AS (SELECT id,body->>'name' AS name FROM han_data.personnel WHERE active AND lower(regexp_replace(body->>'department','[[:space:]_-]','','g')) IN ('callcenter','callcentery','callcentere') AND id NOT IN(SELECT id FROM categories) AND regexp_replace(replace(lower(translate(body->>'name','Iİ','ıi')),'ı','i'),'[[:space:]_-]','','g') NOT IN(SELECT key FROM categories) UNION ALL SELECT id,name FROM categories)
    SELECT p.id,p.name,coalesce(c.collected,0)::text AS collected,coalesce(x.count,0)::text AS "closedCount",coalesce(x.amount,0)::text AS "closedAmount"
    FROM people p LEFT JOIN collections c ON c.staff=p.id LEFT JOIN closures x ON x.staff=p.id ORDER BY coalesce(c.collected,0) DESC,p.name,p.id`,
        [
          from,
          to,
          JSON.stringify(
            Object.entries(require('../turnover-categories.cjs').categories).map(([id, name]) => ({
              id,
              name,
              key: name
                .toLocaleLowerCase('tr-TR')
                .replaceAll('ı', 'i')
                .replace(/[\s_-]+/g, ''),
            })),
          ),
        ],
      );
      return { rows, from, to };
    },
    { readOnly: true },
  );
}
module.exports = { filters, query, reportPage, reportExport, insReport };

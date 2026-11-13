const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
async function search(pool, req, { q = '', kind = '', id = '', after = '' } = {}) {
  if (typeof q !== 'string' || q.length > 200 || !['', 'client', 'document'].includes(kind))
    throw Object.assign(Error('Geçersiz arama.'), { status: 400 });
  if (typeof id !== 'string' || id.length > 200 || (id && kind !== 'client'))
    throw Object.assign(Error('Geçersiz müvekkil seçimi.'), { status: 400 });
  let cursor = null;
  if (typeof after !== 'string' || after.length > 8000)
    throw Object.assign(Error('Geçersiz müvekkil sayfası.'), { status: 400 });
  if (after) {
    try {
      cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
    } catch {
      throw Object.assign(Error('Geçersiz müvekkil sayfası.'), { status: 400 });
    }
    if (
      kind !== 'client' ||
      !cursor ||
      cursor.q !== q.trim() ||
      ![0, 1].includes(cursor.rank) ||
      typeof cursor.name !== 'string' ||
      cursor.name.length > 1000 ||
      typeof cursor.id !== 'string' ||
      cursor.id.length > 200
    )
      throw Object.assign(Error('Geçersiz müvekkil sayfası.'), { status: 400 });
  }
  const words = q.trim().split(/\s+/).filter(Boolean);
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      const manager = ['ceo', 'admin'].includes(user.role);
      const canClients = manager || user.permissions?.includes('clients');
      if (!kind && q.trim().length < 2) return { items: [] };
      const params = words.map((word) => '%' + word.replace(/[\\%_]/g, '\\$&') + '%');
      const predicate = (column) =>
        words
          .map((_, i) => `${column} LIKE han_data.search_normalize($${i + 1}) ESCAPE E'\\\\'`)
          .join(' AND ') || 'true';
      const items = [];
      let more = false,
        next = null;
      if (kind === 'client' || (!kind && canClients)) {
        const clientParams = [...params];
        const prefix = '$' + clientParams.push(q.trim().replace(/[\\%_]/g, '\\$&') + '%');
        const namePrefix = ['name', 'fullName', 'tradeName', 'identity']
          .map(
            (field) =>
              `han_data.search_normalize(body->>'${field}') LIKE han_data.search_normalize(${prefix}) ESCAPE E'\\\\'`,
          )
          .join(' OR ');
        const clientId = id ? ' AND id=$' + clientParams.push(id) : '';
        const rank = `CASE WHEN (${namePrefix}) THEN 0 ELSE 1 END`;
        const page = cursor
          ? ` AND (${rank},name,id)>($${clientParams.push(cursor.rank)},$${clientParams.push(cursor.name)},$${clientParams.push(cursor.id)})`
          : '';
        const { rows } = await db.query(
          `SELECT id, name, body->>'identity' AS identity, body->>'type' AS type,${rank} AS rank
        FROM han_data.clients WHERE active AND ((${predicate('search_text')}) OR (${namePrefix}))${clientId}${page} ORDER BY ${rank},name,id LIMIT 51`,
          clientParams,
        );
        more = rows.length > 50;
        if (more) {
          const last = rows[49];
          next = Buffer.from(
            JSON.stringify({ q: q.trim(), rank: last.rank, name: last.name, id: last.id }),
          ).toString('base64url');
        }
        for (const row of rows.slice(0, 50))
          items.push({ ...row, type: 'client', label: row.name, detail: row.identity || '' });
      }
      if (kind !== 'client') {
        // kind=document lists the open files in entry order, narrowed by the words typed so far.
        const open = kind === 'document' ? " AND d.status NOT IN ('İnfaz','İade')" : '';
        const condition = words
          .map(
            (_, i) =>
              `(d.search_text LIKE han_data.search_normalize($${i + 1}) ESCAPE E'\\\\' OR c.search_text LIKE han_data.search_normalize($${i + 1}) ESCAPE E'\\\\')`,
          )
          .join(' AND ');
        const { rows } = await db.query(
          `SELECT d.id,d.number,d.body->>'debtor' AS debtor,c.name
        FROM han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id
        WHERE d.active${open} AND ${condition || 'true'} ORDER BY d.ordinal,d.id LIMIT 30`,
          params,
        );
        for (const row of rows)
          items.push({
            id: row.id,
            type: 'document',
            label: [row.number, row.debtor].filter(Boolean).join(' · '),
            detail: row.name || '',
          });
      }
      return { items, more: kind === 'client' && more, next: kind === 'client' ? next : null };
    },
    { readOnly: true },
  );
}
module.exports = { search };

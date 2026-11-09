const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
async function search(pool, req, { q = '', kind = '', id = '' } = {}) {
  if (typeof q !== 'string' || q.length > 200 || !['', 'client'].includes(kind))
    throw Object.assign(Error('Geçersiz arama.'), { status: 400 });
  if (typeof id !== 'string' || id.length > 200 || (id && kind !== 'client'))
    throw Object.assign(Error('Geçersiz müvekkil seçimi.'), { status: 400 });
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
      let more = false;
      if (kind === 'client' || canClients) {
        const clientParams = [...params];
        const prefix = '$' + clientParams.push(q.trim().replace(/[\\%_]/g, '\\$&') + '%');
        const namePrefix = ['name', 'fullName', 'tradeName', 'identity']
          .map(
            (field) =>
              `han_data.search_normalize(body->>'${field}') LIKE han_data.search_normalize(${prefix}) ESCAPE E'\\\\'`,
          )
          .join(' OR ');
        const clientId = id ? ' AND id=$' + clientParams.push(id) : '';
        const { rows } = await db.query(
          `SELECT id, name, body->>'identity' AS identity, body->>'type' AS type
        FROM han_data.clients WHERE active AND ((${predicate('search_text')}) OR (${namePrefix}))${clientId} ORDER BY CASE WHEN (${namePrefix}) THEN 0 ELSE 1 END,name,id LIMIT 51`,
          clientParams,
        );
        more = rows.length > 50;
        for (const row of rows.slice(0, 50))
          items.push({ ...row, type: 'client', label: row.name, detail: row.identity || '' });
      }
      if (!kind) {
        const condition = words
          .map(
            (_, i) =>
              `(d.search_text LIKE han_data.search_normalize($${i + 1}) ESCAPE E'\\\\' OR c.search_text LIKE han_data.search_normalize($${i + 1}) ESCAPE E'\\\\')`,
          )
          .join(' AND ');
        const { rows } = await db.query(
          `SELECT d.id,d.number,d.body->>'debtor' AS debtor,c.name
        FROM han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id
        WHERE d.active AND ${condition} ORDER BY d.ordinal,d.id LIMIT 30`,
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
      return { items, more: kind === 'client' && more };
    },
    { readOnly: true },
  );
}
module.exports = { search };

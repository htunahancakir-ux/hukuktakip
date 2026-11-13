const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { parse, searchTokens, evaluate } = require('../conflict-check.cjs');

const like = (token) => '%' + token.replace(/[\\%_]/g, '\\$&') + '%';
const compact = (field) => `regexp_replace(coalesce(${field},''),'[[:space:]]','','g')`;

// Narrow the candidates in SQL (identity, or the longest word of a name), then compare the
// names exactly in conflict-check.cjs. Deleted files and clients stay in their tables as
// inactive rows, so the archive is searched by the same query.
async function conflicts(pool, req, input = {}) {
  const query = parse(input);
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      if (!query.names.length && !query.identity) return { conflicts: 0, infos: 0, hidden: 0, items: [] };
      const patterns = searchTokens(query).map(like);
      const { rows: clients } = await db.query(
        `SELECT id,name,body->>'fullName' AS "fullName",body->>'tradeName' AS "tradeName",
          body->>'identity' AS identity,NOT active AS archived
        FROM han_data.clients
        WHERE ($1<>'' AND ${compact("body->>'identity'")}=$1)
          OR han_data.search_normalize(coalesce(name,'')||' '||coalesce(body->>'fullName','')||' '||coalesce(body->>'tradeName','')) LIKE ANY($2::text[])
        ORDER BY id LIMIT 500`,
        [query.identity, patterns],
      );
      const { rows: documents } = await db.query(
        `SELECT d.id,d.number,d.status,d.staff_id AS "staffId",c.name AS "clientName",
          d.body->>'debtor' AS debtor,d.body->>'identity' AS identity,d.body->>'officeIdentity' AS "officeIdentity",
          d.body->>'clientParty' AS "clientParty",d.body->'guarantors' AS guarantors,NOT d.active AS archived
        FROM han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id
        WHERE ($1<>'' AND (${compact("d.body->>'identity'")}=$1 OR ${compact("d.body->>'officeIdentity'")}=$1
            OR (d.body->'guarantors')::text LIKE '%'||$1||'%'))
          OR han_data.search_normalize(coalesce(d.body->>'debtor','')||' '||coalesce(d.body->>'clientParty','')||' '||coalesce((d.body->'guarantors')::text,'')) LIKE ANY($2::text[])
        ORDER BY d.id LIMIT 1000`,
        [query.identity, patterns],
      );
      return evaluate(query, { clients, documents }, user);
    },
    { readOnly: true },
  );
}

module.exports = { conflicts };

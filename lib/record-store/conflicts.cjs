const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { parse, evaluate } = require('../conflict-check.cjs');
const { partyTokens } = require('../../outputs/icrapro/party-name.js');

const CLIENT_LIMIT = 1000,
  DOCUMENT_LIMIT = 2000,
  PAIR_WORDS = 8;
const compact = (field) => `regexp_replace(coalesce(${field},''),'[[:space:]]','','g')`;

// SQL only gathers the rows that could match; conflict-check.cjs makes the comparison, the same
// one the single-state mode uses. To miss nothing, a row is a candidate when its names contain:
// the word of a one-word name, or any two words of a longer name (a stored name made of two of
// the entered words is a partial match). Words are [a-z0-9]+ only, so they need no LIKE escape.
function nameCandidates(names, params) {
  const any = [],
    bind = (word) => '$' + params.push('%' + word + '%');
  for (const name of names) {
    const words = partyTokens(name);
    if (words.length === 1 || words.length > PAIR_WORDS)
      any.push(...words.map((word) => `h.hay LIKE ${bind(word)}`));
    else {
      const refs = words.map(bind);
      for (let i = 0; i < refs.length; i++)
        for (let j = i + 1; j < refs.length; j++)
          any.push(`(h.hay LIKE ${refs[i]} AND h.hay LIKE ${refs[j]})`);
    }
  }
  return any.length ? '(' + any.join(' OR ') + ')' : 'false';
}

// Deleted files and clients stay in their tables as inactive rows, so the archive is searched
// by the same queries. One read-only snapshot covers both.
async function conflicts(pool, req, input = {}) {
  const query = parse(input);
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      if (!query.names.length && !query.identity) return { conflicts: 0, infos: 0, hidden: 0, items: [] };
      const clientParams = [query.identity],
        documentParams = [query.identity];
      // The normalised names are computed once per row (OFFSET 0 keeps the subquery separate).
      const { rows: clients } = await db.query(
        `SELECT c.id,c.name,c.body->>'fullName' AS "fullName",c.body->>'tradeName' AS "tradeName",
          c.body->>'identity' AS identity,NOT c.active AS archived
        FROM han_data.clients c CROSS JOIN LATERAL (
          SELECT han_data.search_normalize(coalesce(c.name,'')||' '||coalesce(c.body->>'fullName','')||' '||coalesce(c.body->>'tradeName','')) AS hay OFFSET 0
        ) h
        WHERE ($1<>'' AND ${compact("c.body->>'identity'")}=$1) OR ${nameCandidates(query.names, clientParams)}
        ORDER BY c.id LIMIT ${CLIENT_LIMIT + 1}`,
        clientParams,
      );
      const { rows: documents } = await db.query(
        `SELECT d.id,d.number,d.status,d.staff_id AS "staffId",c.name AS "clientName",
          d.body->>'debtor' AS debtor,d.body->>'identity' AS identity,d.body->>'officeIdentity' AS "officeIdentity",
          d.body->>'clientParty' AS "clientParty",d.body->'guarantors' AS guarantors,NOT d.active AS archived
        FROM han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id CROSS JOIN LATERAL (
          SELECT han_data.search_normalize(coalesce(d.body->>'debtor','')||' '||coalesce(d.body->>'clientParty','')||' '||coalesce((d.body->'guarantors')::text,'')) AS hay OFFSET 0
        ) h
        WHERE ($1<>'' AND (${compact("d.body->>'identity'")}=$1 OR ${compact("d.body->>'officeIdentity'")}=$1
            OR (d.body->'guarantors')::text LIKE '%'||$1||'%'))
          OR ${nameCandidates(query.names, documentParams)}
        ORDER BY d.id LIMIT ${DOCUMENT_LIMIT + 1}`,
        documentParams,
      );
      return {
        ...evaluate(
          query,
          { clients: clients.slice(0, CLIENT_LIMIT), documents: documents.slice(0, DOCUMENT_LIMIT) },
          user,
        ),
        // More candidates than are compared: the list may be incomplete, and the screen says so.
        truncated: clients.length > CLIENT_LIMIT || documents.length > DOCUMENT_LIMIT,
      };
    },
    { readOnly: true },
  );
}

module.exports = { conflicts };

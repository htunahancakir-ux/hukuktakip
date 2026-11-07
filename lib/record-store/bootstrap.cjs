const { inTransaction } = require('../db-transaction.cjs');
const { actor, documentPage } = require('./queries.cjs');
const { load } = require('./storage.cjs');
const { join } = require('./codec.cjs');

// This response grows with workspace configuration, not with documents, clients,
// conversations or financial history. Legacy screens explicitly request their
// compatibility data when opened; the primary list never needs that data.
async function bootstrap(pool, req) {
  const all = await documentPage(pool, req, { limit: 1, status: 'Tümü' });
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      const manager = ['ceo', 'admin'].includes(user.role);
      const loaded = await load(db, { tables: ['personnel', 'accounts'] });
      const state = join(loaded.metadata, loaded.rows);
      const data = state.data;
      if (!manager) {
        data['icrapro-personnel-v1'] = data['icrapro-personnel-v1'].map(
          ({ id, name, title, department, active }) => ({ id, name, title, department, active }),
        );
        data['icrapro-settings-v1'] = {
          firm: { name: data['icrapro-settings-v1']?.firm?.name || 'Hukuk Bürosu' },
        };
      }
      const {
        rows: [summary],
      } = await db.query(`SELECT
      (SELECT count(*)::text FROM han_data.clients WHERE active) AS clients,
      count(*)::text AS documents,
      count(*) FILTER (WHERE status IN ('Derdest','İcra'))::text AS "activeDocuments",
      coalesce(sum(round(coalesce(nullif(body->>'amount','')::numeric,0)*100)),0)::text AS "documentAmountCents"
      FROM han_data.documents WHERE active`);
      summary.documents = all.totals.count;
      summary.activeDocuments = String(
        BigInt(all.statusCounts.Derdest || 0) + BigInt(all.statusCounts['İcra'] || 0),
      );
      summary.documentAmountCents = all.totals.principalCents;
      return { data, summary, accountBalances: await require('./accounts.cjs').accountBalances(db) };
    },
    { readOnly: true },
  );
}
module.exports = { bootstrap };

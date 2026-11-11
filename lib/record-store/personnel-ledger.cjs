const { inTransaction } = require('../db-transaction.cjs');
const { actor } = require('./queries.cjs');
const { refreshPayroll } = require('./payroll.cjs');
const { businessDate } = require('../business-time.cjs');
async function refresh(pool) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTransaction(
        pool,
        async (db) => {
          await require('./adapter.cjs').requireActive(db);
          await refreshPayroll(db);
          return { ok: true, month: businessDate().slice(0, 7) };
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      if (attempt >= 2 || !['40001', '40P01'].includes(error.code)) throw error;
    }
  }
}
async function personnelLedger(pool, req, { staffId = '' } = {}) {
  if (typeof staffId !== 'string' || staffId.length > 200)
    throw Object.assign(Error('Geçersiz personel.'), { status: 400 });
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTransaction(
        pool,
        async (db) => {
          const user = await actor(db, req);
          if (!['ceo', 'admin'].includes(user.role))
            throw Object.assign(Error('Personel carilerini yalnızca yönetici görebilir.'), { status: 403 });
          await refreshPayroll(db);
          const {
            rows: [metadata],
          } = await db.query('SELECT body FROM han_data.metadata WHERE id=1');
          const { rows: people } = await db.query(
            'SELECT body FROM han_data.personnel WHERE active ORDER BY ordinal,id',
          );
          const { rows: accounts } = await db.query(
            'SELECT body FROM han_data.accounts WHERE active ORDER BY ordinal,id',
          );
          const base = {
            people: people.map((row) => ({
              id: row.body.id,
              name: row.body.name,
              active: row.body.active !== false,
            })),
            accounts: accounts.map((row) => row.body),
            startMonth: require('../personnel-ledger.cjs').START_MONTH,
          };
          if (!staffId) return base;
          const { rows: payments } = await db.query(
            "SELECT body FROM han_data.ledger_entries WHERE active AND body->>'staffId'=$1 ORDER BY ordinal,id",
            [staffId],
          );
          const state = {
            ...metadata.body,
            data: {
              ...metadata.body.data,
              'icrapro-personnel-v1': people.map((row) => row.body),
              'hanhukuk-accounting-v1': { accounts: base.accounts, entries: payments.map((row) => row.body) },
            },
          };
          return { ...base, ...require('../personnel-ledger.cjs').details(state, staffId, businessDate()) };
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      if (attempt >= 2 || !['40001', '40P01'].includes(error.code)) throw error;
    }
  }
}
module.exports = { personnelLedger, refresh };

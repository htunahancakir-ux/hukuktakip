const { inTransaction } = require('../db-transaction.cjs');
const { businessDate } = require('../business-time.cjs');
const { syncParkingWaiting } = require('../../outputs/icrapro/parking-waiting.js');
// Read only the fields needed for status calculation; keep every other document
// field intact. A bounded transaction and row locks coordinate concurrent readers.
async function refreshParkingWaiting(pool, today = businessDate()) {
  for (;;) {
    const count = await inTransaction(pool, (db) => refreshParkingWaitingBatch(db, today));
    if (count < 200) return;
  }
}
async function refreshParkingWaitingBatch(db, today = businessDate()) {
  const { rows } = await db.query(
    `SELECT id,jsonb_build_object(
        'docType',body->>'docType','status',body->>'status','parkingEntry',body->>'parkingEntry',
        'receivables',body->'receivables','parkingProcessOn',body->>'parkingProcessOn',
        'parkingWaitingVersion',body->'parkingWaitingVersion') AS record
        FROM han_data.documents WHERE active AND status NOT IN ('İnfaz','İade')
        AND (kind='Yediemin Park Ücreti' OR body->'receivables' @> '[{"docType":"Yediemin Park Ücreti"}]'::jsonb)
        AND (body->>'parkingWaitingVersion' IS DISTINCT FROM '1'
          OR (status='Bekleme' AND nullif(body->>'parkingProcessOn','')<=$1))
        ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`,
    [today],
  );
  for (const row of rows) {
    syncParkingWaiting(row.record, today);
    const { status, parkingProcessOn, parkingWaitingVersion } = row.record;
    await db.query(
      `UPDATE han_data.documents SET body=body||$2::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, JSON.stringify({ status, parkingProcessOn, parkingWaitingVersion })],
    );
  }
  return rows.length;
}
module.exports = { refreshParkingWaiting, refreshParkingWaitingBatch };

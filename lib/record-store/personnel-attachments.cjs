const { actor } = require('./queries.cjs');
const { inTransaction } = require('../db-transaction.cjs');
async function personnelAttachments(pool, req, { personnelId, attachmentId = '' } = {}) {
  return inTransaction(
    pool,
    async (db) => {
      const user = await actor(db, req);
      if (!['ceo', 'admin'].includes(user.role))
        throw Object.assign(Error('Personel ekleri için yönetici yetkisi gerekli.'), { status: 403 });
      if (
        typeof personnelId !== 'string' ||
        !personnelId ||
        personnelId.length > 200 ||
        typeof attachmentId !== 'string' ||
        attachmentId.length > 400
      )
        throw Object.assign(Error('Geçersiz personel veya ek.'), { status: 400 });
      const { rows: people } = await db.query('SELECT id FROM han_data.personnel WHERE id=$1 AND active', [
        personnelId,
      ]);
      if (!people.length) throw Object.assign(Error('Personel bulunamadı.'), { status: 404 });
      if (attachmentId) {
        const { rows } = await db.query(
          "SELECT body->'value' AS value FROM han_data.attachments WHERE active AND body->>'personnelId'=$1 AND id=$2",
          [personnelId, attachmentId],
        );
        if (!rows.length) throw Object.assign(Error('Ek bulunamadı.'), { status: 404 });
        return { attachment: rows[0].value };
      }
      const { rows } = await db.query(
        "SELECT id,body->'value'->>'name' AS name,body->'value'->>'mime' AS mime,body->'value'->>'createdAt' AS \"createdAt\" FROM han_data.attachments WHERE active AND body->>'personnelId'=$1 ORDER BY ordinal,id",
        [personnelId],
      );
      return { items: rows };
    },
    { readOnly: true },
  );
}
module.exports = { personnelAttachments };

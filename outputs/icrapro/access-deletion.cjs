const { canDelete, denied } = require('../../lib/deletion-policy.cjs');
const crypto = require('node:crypto');
function rowsFor(state, type) {
  const data = state.data,
    records = data['icrapro-v1'];
  const types = {
    documents: records.docs,
    clients: records.clients,
    finance: data['hanhukuk-finance-v1'],
    accounting: data['hanhukuk-accounting-v1'].entries,
    accounts: data['hanhukuk-accounting-v1'].accounts,
    personnel: data['icrapro-personnel-v1'],
    cases: data['icrapro-cases-v1'],
  };
  if (type === 'conversations')
    return records.docs.flatMap((d) =>
      (d.conversations || []).map((c) => ({ ...c, documentId: d.id, documentNumber: d.number })),
    );
  return types[type];
}
async function handleDeletionRoutes(ctx) {
  const { req, res, url, u, body, send, fail, persist } = ctx;
  if (url.pathname !== '/api/operations/delete') return false;
  if (!canDelete(u)) throw denied();
  if (req.method === 'GET') {
    const type = url.searchParams.get('type'),
      rows = rowsFor(ctx.state, type);
    if (!rows) throw fail(400, 'Geçerli kayıt türü seçin.');
    const q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('tr');
    const docs = ctx.state.data['icrapro-v1'].docs;
    const labels = {
      clientPayout: 'Müvekkil Ödemesi',
      payment: 'Tahsilat',
      expense: 'Masraf',
      costOnly: 'Masraf',
      in: 'Giriş',
      out: 'Çıkış',
      transfer: 'Transfer',
      advance: 'Avans',
    };
    const items = rows
      .filter((r) => r.id)
      .map((r) => ({
        id: r.id,
        documentId: r.documentId,
        label: [
          r.number || r.documentNumber || docs.find((d) => d.id === r.documentId)?.number,
          r.name || r.debtor || labels[r.type] || r.type,
          r.note || r.notes || r.title,
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 250),
        date: r.date || r.createdAt || r.created || '',
        amount: r.amount,
        amountTl: ['finance', 'accounting'].includes(type)
          ? Number(r.amount) / 100
          : typeof r.amount === 'number'
            ? r.amount
            : undefined,
        revision: crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex'),
      }))
      .filter((r) => !q || r.label.toLocaleLowerCase('tr').includes(q));
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    send(res, 200, { items: items.slice(offset, offset + 50), total: items.length });
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'Yöntem desteklenmiyor.');
  const input = await body(req),
    next = structuredClone(ctx.state),
    rows = rowsFor(next, input.type);
  if (!rows) throw fail(400, 'Geçerli kayıt türü seçin.');
  const index = rows.findIndex(
    (r) => r.id === input.id && (input.type !== 'conversations' || r.documentId === input.documentId),
  );
  if (index < 0) throw fail(404, 'Kayıt bulunamadı; listeyi yenileyin.');
  const row = rows[index];
  const revision = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  if (input.revision !== revision) throw fail(409, 'Kayıt değişti; listeyi yenileyip tekrar kontrol edin.');
  const data = next.data,
    docs = data['icrapro-v1'].docs,
    ledger = data['hanhukuk-accounting-v1'];
  if (input.type === 'clients' && docs.some((d) => d.client === row.id))
    throw fail(409, 'Önce müvekkile bağlı dosyaları arşive alın.');
  if (
    input.type === 'personnel' &&
    (next.users.some((u) => u.staffId === row.id) || docs.some((d) => d.relatedStaff === row.id))
  )
    throw fail(409, 'Personele bağlı hesap veya dosya var. Önce bağlantılarını düzenleyin.');
  if (
    input.type === 'accounts' &&
    (ledger.entries.some((e) => e.accountId === row.id || e.destination === row.id) ||
      data['hanhukuk-finance-v1'].some((e) => e.accountId === row.id))
  )
    throw fail(409, 'Hesapta kayıtlı hareket var. Önce hareketlerini düzenleyin.');
  if (
    input.type === 'finance' &&
    ledger.entries.some((e) => e.type === 'clientPayout' && e.documentId === row.documentId)
  )
    throw fail(409, 'Dosyada müvekkil ödemesi var. Önce müvekkil ödeme kaydını kontrol edin.');
  if (input.type === 'conversations') {
    const doc = docs.find((d) => d.id === row.documentId);
    doc.conversations = doc.conversations.filter((c) => c.id !== row.id);
  } else rows.splice(index, 1);
  if (input.type === 'finance' && row.type === 'payment') {
    const doc = docs.find((d) => d.id === row.documentId);
    if (doc?.status === 'İnfaz') {
      doc.status = doc.enforcementFileNumber ? 'İcra' : 'Derdest';
      delete doc.closedDate;
    }
  }
  next.deletedOperations = [
    ...(next.deletedOperations || []),
    {
      id: crypto.randomUUID(),
      type: input.type,
      record: row,
      deletedAt: new Date().toISOString(),
      deletedBy: u.id,
      deletedByName: u.name,
    },
  ];
  persist(next);
  send(res, 200, { ok: true });
  return true;
}
module.exports = { handleDeletionRoutes, rowsFor };

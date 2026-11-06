const { activeArchives } = require('../../lib/document-archive.cjs');

async function handleDocumentRoutes(ctx) {
  const { req, res, url, u, persist, current, allowed, fail, body, send, parkingToday, applyParkingFee } =
    ctx;
  if (url.pathname === '/api/documents/delete' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Dosyayı yalnızca CEO ve yönetici silebilir.');
    const v = await body(req),
      doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId);
    if (!doc) throw fail(404, 'Dosya bulunamadı.');
    const next = structuredClone(ctx.state);
    next.data['icrapro-v1'].docs = next.data['icrapro-v1'].docs.filter((d) => d.id !== doc.id);
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/documents/archived' && req.method === 'GET') {
    if (!['ceo', 'admin'].includes(u.role))
      throw fail(403, 'Silinen evrakları yalnızca yöneticiler görebilir.');
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    const rows = activeArchives(ctx.state).slice().reverse();
    const items = rows.slice(offset, offset + 50).map(({ document, deletedAt, deletedByName }) => ({
      id: document.id,
      number: document.number,
      debtor: document.debtor,
      type: document.docType,
      deletedAt,
      deletedByName,
    }));
    send(res, 200, { items, total: rows.length });
    return true;
  }
  if (url.pathname === '/api/documents/restore' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Evrakı yalnızca yönetici arşivden çıkarabilir.');
    const { documentId } = await body(req);
    const next = structuredClone(ctx.state);
    const archived = activeArchives(next).findLast((entry) => entry.document.id === documentId);
    if (!archived) throw fail(404, 'Evrak arşivde bulunamadı.');
    const doc = structuredClone(archived.document);
    const { clients, docs } = next.data['icrapro-v1'];
    if (doc.client && !clients.some((client) => client.id === doc.client))
      throw fail(409, 'Evrakın bağlı olduğu müvekkil bulunamadı.');
    if (docs.some((row) => row.id === doc.id || (doc.number && row.number === doc.number)))
      throw fail(409, 'Aktif listede aynı numarada bir evrak var.');
    doc.linkedDocumentIds = (doc.linkedDocumentIds || []).filter((id) => docs.some((row) => row.id === id));
    for (const row of docs)
      if (doc.linkedDocumentIds.includes(row.id))
        row.linkedDocumentIds = [...new Set([...(row.linkedDocumentIds || []), doc.id])];
    docs.push(doc);
    archived.restoredAt = new Date().toISOString();
    archived.restoredBy = u.id;
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/documents/chain' && req.method === 'POST') {
    if (!allowed(u, 'documents')) throw fail(403, 'Dosya zinciri için evrak yetkisi gerekli.');
    const v = await body(req),
      docs = ctx.state.data['icrapro-v1'].docs,
      a = docs.find((d) => d.id === v.documentId),
      b = docs.find((d) => d.id === v.targetId);
    if (!a || !b || a.id === b.id || !['add', 'remove'].includes(v.action))
      throw fail(400, 'Farklı ve geçerli bir dosya seçin.');
    const next = structuredClone(ctx.state);
    for (const [id, target] of [
      [a.id, b.id],
      [b.id, a.id],
    ]) {
      const d = next.data['icrapro-v1'].docs.find((d) => d.id === id),
        links = new Set(d.linkedDocumentIds || []);
      if (v.action === 'add') links.add(target);
      else links.delete(target);
      d.linkedDocumentIds = [...links];
      d.chainUpdatedBy = u.id;
      d.chainUpdatedAt = new Date().toISOString();
    }
    persist(next);
    send(res, 200, {
      documents: next.data['icrapro-v1'].docs.filter((d) => [a.id, b.id].includes(d.id)),
    });
    return true;
  }
  if (url.pathname === '/api/documents/enforcement' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Dosyayı icraya yalnızca yönetici taşıyabilir.');
    const v = await body(req),
      doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId);
    if (!doc) throw fail(404, 'Dosya bulunamadı.');
    if (doc.status === 'İcra' && !v.enforcementDetails) {
      send(res, 200, { document: doc });
      return true;
    }
    if (
      v.enforcementDetails &&
      (!String(v.enforcementFileNumber || '').trim() ||
        String(v.enforcementFileNumber).length > 100 ||
        String(v.enforcementOffice || '').length > 200)
    )
      throw fail(400, 'Geçerli icra dosya numarası girin.');
    if (doc.status && !['Derdest', 'İcra'].includes(doc.status))
      throw fail(400, 'Yalnızca derdest dosya icraya taşınabilir.');
    const events = ctx.state.data['hanhukuk-finance-v1'].filter((e) => e.documentId === doc.id),
      received = events.filter((e) => e.type === 'payment').reduce((sum, e) => sum + e.amount, 0);
    const current = structuredClone(doc);
    applyParkingFee(current, parkingToday());
    const principal = Math.round(Number(current.amount || 0) * 100),
      parking = current.docType === 'Yediemin Park Ücreti',
      total = Math.max(
        0,
        principal +
          (parking
            ? 0
            : Math.round(Number(current.financeInterest || 0) * 100) +
              Math.round(Number(current.financeFee || 0) * 100) +
              events.filter((e) => e.type === 'expense').reduce((sum, e) => sum + e.amount, 0)) -
          Number(current.debtDiscountCents || 0),
      );
    if (received > 0 && received >= total) throw fail(400, 'Tamamı tahsil edilmiş dosya icraya taşınamaz.');
    const next = structuredClone(ctx.state),
      record = next.data['icrapro-v1'].docs.find((d) => d.id === doc.id);
    if (v.enforcementDetails) {
      record.enforcementOffice = String(v.enforcementOffice || '').trim();
      record.enforcementFileNumber = String(v.enforcementFileNumber).trim();
      record.enforcementUpdatedBy = u.id;
      record.enforcementUpdatedAt = new Date().toISOString();
    }
    record.status = 'İcra';
    record.enforcementTransferredAt = new Date().toISOString();
    record.enforcementTransferredBy = u.id;
    record.enforcementTransferredByName = u.name;
    record.statusHistory = [
      ...(record.statusHistory || []),
      {
        from: 'Derdest',
        to: 'İcra',
        date: record.enforcementTransferredAt,
        operatorId: u.id,
        operatorName: u.name,
      },
    ];
    persist(next);
    const result = structuredClone(record);
    applyParkingFee(result, parkingToday());
    send(res, 200, { document: result });
    return true;
  }
  if (url.pathname === '/api/documents/assign' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role))
      throw fail(403, 'Dosya sorumlusunu yalnızca yönetici atayabilir.');
    const v = await body(req),
      doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId),
      staff = ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === v.staffId && p.active === true);
    if (!doc) throw fail(404, 'Borçlu dosyası bulunamadı.');
    if (!staff) throw fail(400, 'Aktif bir personel seçin.');
    const next = structuredClone(ctx.state),
      record = next.data['icrapro-v1'].docs.find((d) => d.id === doc.id);
    if (record.relatedStaff !== staff.id) {
      record.assignmentVersion = Number(record.assignmentVersion || 0) + 1;
      record.assignmentHistory = [
        ...(record.assignmentHistory || []),
        {
          from: record.relatedStaff || '',
          to: staff.id,
          staffName: staff.name,
          assignedBy: u.id,
          assignedByName: u.name,
          date: new Date().toISOString(),
        },
      ];
      record.relatedStaff = staff.id;
      record.relatedStaffName = staff.name;
      record.updatedAt = new Date().toISOString();
      persist(next);
    }
    const result = structuredClone(record);
    applyParkingFee(result, parkingToday());
    send(res, 200, { document: result });
    return true;
  }
  return false;
}

module.exports = { handleDocumentRoutes };

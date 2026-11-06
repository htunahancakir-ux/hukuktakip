function activeArchives(state) {
  return (state.deletedDocuments || []).filter((entry) => entry.document?.id && !entry.restoredAt);
}

function archiveRemovedDocuments(before, next, actor) {
  const docs = next.data['icrapro-v1'].docs;
  const live = new Set(docs.map((doc) => doc.id));
  const removed = before.data['icrapro-v1'].docs.filter((doc) => !live.has(doc.id));
  if (!removed.length) return;
  if (!['ceo', 'admin'].includes(actor.role))
    throw Object.assign(new Error('Evrakı yalnızca yönetici arşive alabilir.'), { code: 403 });
  const deleted = new Set(removed.map((doc) => doc.id));
  const archived = new Set(activeArchives(next).map((entry) => entry.document.id));
  next.deletedDocuments ||= [];
  for (const doc of removed)
    if (!archived.has(doc.id)) {
      next.deletedDocuments.push({
        document: structuredClone(doc),
        deletedAt: new Date().toISOString(),
        deletedBy: actor.id,
        deletedByName: actor.name,
      });
    }
  for (const doc of docs)
    if (Array.isArray(doc.linkedDocumentIds))
      doc.linkedDocumentIds = doc.linkedDocumentIds.filter((id) => !deleted.has(id));
}

function preventArchivedNumberReuse(before, next) {
  const archived = activeArchives(next);
  if (!archived.length) return;
  const normalize = (number) => String(number || '').toLocaleUpperCase('tr');
  const reserved = new Set(archived.map((entry) => normalize(entry.document.number)).filter(Boolean));
  const previous = new Map(before.data['icrapro-v1'].docs.map((doc) => [doc.id, normalize(doc.number)]));
  const reused = next.data['icrapro-v1'].docs.some(
    (doc) => previous.get(doc.id) !== normalize(doc.number) && reserved.has(normalize(doc.number)),
  );
  if (reused)
    throw Object.assign(
      new Error('Bu evrak numarası arşivde kullanılıyor. Listeyi yenileyip tekrar deneyin.'),
      { code: 409 },
    );
}

module.exports = { activeArchives, archiveRemovedDocuments, preventArchivedNumberReuse };

function normalize(value) {
  return String(value ?? '')
    .toLocaleLowerCase('tr')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ı', 'i')
    .trim();
}

function score(values, phones, query) {
  const terms = query.split(/\s+/);
  const candidates = values.map(normalize).filter(Boolean);
  if (candidates.includes(query)) return 3;
  if (candidates.some((value) => value.startsWith(query))) return 2;
  if (terms.every((term) => candidates.some((value) => value.includes(term)))) return 1;
  if (/^[+\d\s().-]+$/.test(query)) {
    const digits = query.replace(/\D/g, '');
    if (
      digits.length >= 4 &&
      phones.some((value) =>
        String(value || '')
          .replace(/\D/g, '')
          .includes(digits),
      )
    )
      return 1;
  }
  return 0;
}

function searchWorkspace(state, user, input) {
  const query = normalize(input);
  if (query.length < 2 || query.length > 80) return [];
  const manager = ['ceo', 'admin'].includes(user.role);
  const canSeeClients = manager || user.permissions?.includes('clients');
  const { clients = [], docs = [] } = state.data['icrapro-v1'] || {};
  const found = [];
  const add = (type, row, label, detail, relevance) => {
    if (relevance) found.push({ type, id: row.id, label, detail, relevance });
  };
  for (const row of docs) {
    if (!manager && (!user.staffId || row.relatedStaff !== user.staffId)) continue;
    add(
      'document',
      row,
      row.debtor || 'İsimsiz evrak',
      [row.number, row.enforcementFileNumber].filter(Boolean).join(' / '),
      score(
        [row.debtor, row.number, row.enforcementFileNumber],
        [
          row.phone1,
          row.phone2,
          row.officePhone1,
          row.officePhone2,
          row.referencePhone1,
          row.referencePhone2,
          ...(row.additionalPhones || []),
        ],
        query,
      ),
    );
  }
  if (canSeeClients) {
    for (const row of clients)
      add(
        'client',
        row,
        row.name || 'İsimsiz müvekkil',
        row.type || '',
        score([row.name], [row.phone, row.phone1, row.phone2, ...(row.additionalPhones || [])], query),
      );
  }
  return found
    .sort((a, b) => b.relevance - a.relevance || a.label.localeCompare(b.label, 'tr'))
    .slice(0, 12)
    .map(({ relevance, ...row }) => row);
}

module.exports = { searchWorkspace };

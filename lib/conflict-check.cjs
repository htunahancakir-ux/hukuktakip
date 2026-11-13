const { partyTokens, partyNamesMatch, partyIdentity } = require('../outputs/icrapro/party-name.js');

// Conflict of interest check: does a party being entered already appear in any file, in any
// role? A match on the other side (client against debtor or guarantor) is a conflict; a match
// on the same side is only information (the same debtor's second file, a returning client).
const KINDS = new Set(['client', 'debtor', 'guarantor']);
const MAX_ITEMS = 50;
const fail = (code, message) => Object.assign(Error(message), { code, status: code });
const side = (role) => (role === 'client' ? 'client' : 'opponent');

function parse(input) {
  if (!input || typeof input !== 'object' || !KINDS.has(input.kind)) throw fail(400, 'Geçersiz taraf türü.');
  const names = [input.name, input.name2]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().slice(0, 200))
    .filter((value) => partyTokens(value).length);
  return { kind: input.kind, names, identity: partyIdentity(input.identity) };
}

// The longest word of each name narrows the SQL search before the exact comparison here.
function searchTokens(query) {
  return query.names.map(
    (name) =>
      partyTokens(name)
        .slice()
        .sort((a, b) => b.length - a.length)[0],
  );
}

function viewer(user) {
  const manager = ['ceo', 'admin'].includes(user.role);
  return {
    manager,
    staffId: user.staffId || '',
    clients: manager || (user.permissions || []).includes('clients'),
  };
}

// clients: [{id,name,fullName,tradeName,identity,archived}]
// documents: [{id,number,status,staffId,clientName,debtor,identity,officeIdentity,clientParty,guarantors,archived}]
function evaluate(query, { clients = [], documents = [] }, user) {
  const who = viewer(user),
    ownSide = side(query.kind),
    found = [];
  const match = (names, identities) => {
    const identityMatch =
      !!query.identity && identities.some((value) => partyIdentity(value) === query.identity);
    let nameMatch = null,
      name = names.find(Boolean) || '';
    for (const candidate of names.filter(Boolean)) {
      for (const entered of query.names) {
        const result = partyNamesMatch(entered, candidate);
        if (result && (nameMatch !== 'exact' || result === 'exact')) {
          if (!nameMatch || result === 'exact') name = candidate;
          nameMatch = nameMatch === 'exact' ? 'exact' : result;
        }
      }
    }
    return identityMatch || nameMatch ? { identityMatch, nameMatch, name } : null;
  };
  const add = (role, hit, reference, visible) => {
    if (hit) found.push({ role, ...hit, conflict: side(role) !== ownSide, ...reference, visible });
  };
  for (const client of clients)
    add(
      'client',
      match([client.name, client.fullName, client.tradeName], [client.identity]),
      { archived: !!client.archived },
      who.manager || (who.clients && !client.archived),
    );
  for (const doc of documents) {
    const reference = {
        documentId: doc.id,
        number: doc.number || '',
        status: doc.status || '',
        clientName: doc.clientName || '',
        archived: !!doc.archived,
      },
      visible = who.manager || (!doc.archived && !!who.staffId && doc.staffId === who.staffId);
    add('debtor', match([doc.debtor], [doc.identity, doc.officeIdentity]), reference, visible);
    add('client', match([doc.clientParty], []), reference, visible);
    for (const guarantor of Array.isArray(doc.guarantors) ? doc.guarantors : [])
      add('guarantor', match([guarantor?.name], [guarantor?.identity]), reference, visible);
  }
  const rank = (item) => (item.conflict ? 0 : 2) + (item.identityMatch || item.nameMatch === 'exact' ? 0 : 1);
  found.sort((a, b) => rank(a) - rank(b) || String(a.number || '').localeCompare(String(b.number || '')));
  const shown = found.filter((item) => item.visible);
  return {
    conflicts: found.filter((item) => item.conflict).length,
    infos: found.filter((item) => !item.conflict).length,
    hidden: found.length - shown.length,
    // Files the user may not open are counted, never described.
    items: shown.slice(0, MAX_ITEMS).map(({ visible, ...item }) => item),
  };
}

// Compatibility (single state) mode: compare against everything in the state.
function fromState(state, input, user) {
  const query = parse(input);
  if (!query.names.length && !query.identity) return { conflicts: 0, infos: 0, hidden: 0, items: [] };
  const records = state.data['icrapro-v1'],
    clientNames = new Map(records.clients.map((client) => [client.id, client.name])),
    document = (doc, archived) => ({
      id: doc.id,
      number: doc.number,
      status: doc.status,
      staffId: doc.relatedStaff || '',
      clientName: clientNames.get(doc.client) || '',
      debtor: doc.debtor,
      identity: doc.identity,
      officeIdentity: doc.officeIdentity,
      clientParty: doc.clientParty,
      guarantors: doc.guarantors,
      archived,
    });
  return evaluate(
    query,
    {
      clients: records.clients,
      documents: [
        ...records.docs.map((doc) => document(doc, false)),
        ...require('./document-archive.cjs')
          .activeArchives(state)
          .map((entry) => document(entry.document, true)),
      ],
    },
    user,
  );
}

function acknowledgement(input) {
  const reason = typeof input?.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '',
    name = typeof input?.name === 'string' ? input.name.trim().slice(0, 200) : '';
  if (!KINDS.has(input?.kind) || !name) throw fail(400, 'Geçersiz istek.');
  if (reason.length < 10 || reason.length > 500)
    throw fail(400, 'Çakışmaya rağmen devam etmek için 10–500 karakterlik gerekçe yazın.');
  return {
    kind: input.kind,
    name,
    reason,
    count: Number.isSafeInteger(input.count) && input.count > 0 && input.count < 100000 ? input.count : 0,
  };
}

module.exports = { parse, searchTokens, evaluate, fromState, acknowledgement };

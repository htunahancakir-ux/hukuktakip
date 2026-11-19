const { isDeepStrictEqual } = require('node:util');

const actions = {
  view: 'Görüntüleme',
  create: 'Yeni kayıt',
  update: 'Düzenleme',
  delete: 'Silme',
  pay: 'Ödeme yapma',
};
const modules = {
  clients: ['Müvekkiller', ['create', 'update', 'delete']],
  documents: ['Evrak Kabul ve Borçlu Dosyaları', ['create', 'update', 'delete']],
  finance: ['Tahsilat ve Masraf Hareketleri', ['create', 'update', 'delete']],
  accounting: ['Muhasebe ve Müvekkil Ödemeleri', ['create', 'update', 'delete']],
  personnel: ['Personel Kayıtları', ['create', 'update', 'delete']],
  personnelLedger: ['Personel Cari ve Hakediş Dönemleri', ['view', 'pay']],
  cases: ['İcra İşlemleri', ['create', 'update', 'delete']],
  marketing: ['Pazarlama Kayıtları ve Rotalar', ['create', 'update', 'delete']],
  messages: ['Personel Mesajları', ['create', 'delete']],
  workOrders: ['İş Emirleri', ['create', 'update']],
  reminders: ['Hatırlatmalar', ['create', 'update', 'delete']],
  calls: ['Telefon Görüşme Kayıtları', ['delete']],
};

const deletionTypes = {
  accounting: 'accounting',
  finance: 'finance',
  conversations: 'documents',
  messages: 'messages',
  documents: 'documents',
  clients: 'clients',
  accounts: 'accounting',
  marketing: 'marketing',
  personnel: 'personnel',
  cases: 'cases',
};

function moduleError(code, message) {
  return Object.assign(Error(message), { code, status: code });
}

function normalizePermissions(value) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw moduleError(400, 'Geçerli modül yetkileri girin.');
  for (const [module, rules] of Object.entries(value)) {
    if (!Object.hasOwn(modules, module) || !rules || typeof rules !== 'object' || Array.isArray(rules))
      throw moduleError(400, 'Geçersiz modül yetkisi.');
    for (const [action, allowed] of Object.entries(rules)) {
      if (!modules[module][1].includes(action) || typeof allowed !== 'boolean')
        throw moduleError(400, 'Geçersiz işlem yetkisi.');
      (normalized[module] ||= {})[action] = allowed;
    }
  }
  return normalized;
}

function restricted(user, module, action) {
  return user?.role !== 'ceo' && user?.modulePermissions?.[module]?.[action] === false;
}

function assertModuleAction(user, module, action) {
  if (restricted(user, module, action))
    throw moduleError(
      403,
      `${modules[module][0]} bölümünde ${actions[action].toLocaleLowerCase('tr')} yetkiniz kapalı.`,
    );
}

function assertCollection(user, module, previous, incoming) {
  if (
    !Array.isArray(previous) ||
    !Array.isArray(incoming) ||
    !['create', 'update', 'delete'].some((action) => restricted(user, module, action))
  )
    return;
  const before = new Map(previous.map((row) => [row.id, row]));
  const after = new Set();
  for (const row of incoming) {
    if (typeof row?.id !== 'string' || !row.id || after.has(row.id))
      throw moduleError(400, 'Kayıt kimliği eksik veya tekrarlı.');
    after.add(row.id);
    const old = before.get(row.id);
    if (!old) assertModuleAction(user, module, 'create');
    else if (!isDeepStrictEqual(old, row)) {
      assertModuleAction(user, module, 'update');
      if (['documents', 'clients'].includes(module)) {
        for (const field of ['attachments', 'guarantors', 'conversations', 'receivables']) {
          const remaining = new Set((Array.isArray(row[field]) ? row[field] : []).map((item) => item?.id));
          if (Array.isArray(old[field]) && old[field].some((item) => item?.id && !remaining.has(item.id)))
            assertModuleAction(user, module, 'delete');
        }
      }
    }
  }
  if (previous.some((row) => !after.has(row.id))) assertModuleAction(user, module, 'delete');
}

function assertDataActions(user, key, previous, incoming) {
  if (!user.modulePermissions || user.role === 'ceo') return;
  switch (key) {
    case 'icrapro-v1':
      assertCollection(user, 'clients', previous?.clients, incoming?.clients);
      assertCollection(user, 'documents', previous?.docs, incoming?.docs);
      break;
    case 'hanhukuk-accounting-v1':
      assertCollection(user, 'accounting', previous?.accounts, incoming?.accounts);
      assertCollection(user, 'accounting', previous?.entries, incoming?.entries);
      if (restricted(user, 'accounting', 'delete') || restricted(user, 'accounting', 'update')) {
        const before = previous?.excludedFinanceIds || [];
        const after = incoming?.excludedFinanceIds || [];
        if (!Array.isArray(after)) throw moduleError(400, 'Geçersiz muhasebe kaydı.');
        if (after.some((id) => !before.includes(id))) assertModuleAction(user, 'accounting', 'delete');
        if (before.some((id) => !after.includes(id))) assertModuleAction(user, 'accounting', 'update');
      }
      break;
    case 'hanhukuk-finance-v1':
      assertCollection(user, 'finance', previous, incoming);
      break;
    case 'icrapro-personnel-v1':
      assertCollection(user, 'personnel', previous, incoming);
      break;
    case 'icrapro-cases-v1':
      assertCollection(user, 'cases', previous, incoming);
      break;
  }
}

// Fixed-action commands. Mixed commands (data patches, reminders, attachments,
// and scoped deletion) determine the action from their validated input.
const postActions = {
  '/api/documents/manual-close': ['documents', 'update'],
  '/api/documents/principal': ['documents', 'update'],
  '/api/documents/restore': ['documents', 'create'],
  '/api/documents/chain': ['documents', 'update'],
  '/api/documents/enforcement': ['documents', 'update'],
  '/api/documents/assign': ['documents', 'update'],
  '/api/documents/conversations': ['documents', 'update'],
  '/api/documents/conversation-report': ['documents', 'update'],
  '/api/documents/currency-terms': ['documents', 'update'],
  '/api/payment-promises': ['documents', 'update'],
  '/api/call-reminders/done': ['documents', 'update'],
  '/api/personnel-payroll': ['personnel', 'update'],
  '/api/cash-entry': ['accounting', 'create'],
  '/api/client-payout': ['accounting', 'create'],
  '/api/expense-pool/fund': ['accounting', 'create'],
  '/api/expense-pool/allocate': ['finance', 'create'],
  '/api/documents/currency-collection': ['finance', 'create'],
  '/api/marketing-prospects': ['marketing', 'create'],
  '/api/marketing/routes': ['marketing', 'create'],
  '/api/messages': ['messages', 'create'],
  '/api/work-orders': ['workOrders', 'create'],
  '/api/work-orders/complete': ['workOrders', 'update'],
};

function assertRequestAction(user, path, method) {
  if (method === 'PUT' && path === '/api/marketing-prospects')
    assertModuleAction(user, 'marketing', 'update');
  const policy = method === 'POST' && postActions[path];
  if (policy) assertModuleAction(user, ...policy);
}

module.exports = {
  actions,
  modules,
  deletionTypes,
  moduleError,
  normalizePermissions,
  assertModuleAction,
  assertDataActions,
  assertRequestAction,
  restricted,
};

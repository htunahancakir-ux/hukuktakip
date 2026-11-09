const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const PAGE_SIZE = 40;
const categories = new Set(['changes', 'login', 'logout', 'failed']);
const actions = new Set([
  'create',
  'update',
  'delete',
  'download',
  'backup',
  'restore',
  'whatsapp',
  'accept',
  'publish',
  'resend',
]);
const fields = {
  name: 'Ad / unvan',
  username: 'Kullanıcı adı',
  whatsappPhone: 'WhatsApp numarası',
  whatsappAllowed: 'WhatsApp gönderim onayı',
  hash: 'Parola',
  salt: 'Parola',
  role: 'Rol',
  active: 'Hesap durumu',
  permissions: 'Yetkiler',
  readOnly: 'Salt okunur erişim',
  staffId: 'Personel bağlantısı',
  clientId: 'Müvekkil',
  debtor: 'Borçlu',
  address: 'Adres',
  phone: 'Telefon',
  phones: 'Telefonlar',
  notes: 'Notlar',
  amount: 'Tutar',
  status: 'Durum',
  date: 'Tarih',
  due: 'Vade',
  number: 'Evrak numarası',
  trackingDate: 'Takip tarihi',
  enforcementFileNumber: 'İcra dosya numarası',
  relatedStaff: 'Dosya sorumlusu',
  conversations: 'Görüşmeler',
  paymentPromise: 'Ödeme sözü',
  repaymentPlan: 'Ödeme planı',
  attachments: 'Ekler',
  attachment: 'Ek',
  workOrders: 'İş emirleri',
  readBy: 'Okunma durumu',
  firm: 'Firma bilgileri',
  contact: 'İletişim bilgileri',
  preferences: 'Uygulama tercihleri',
  accountId: 'Hesap',
  description: 'Açıklama',
  result: 'Sonuç',
  salary: 'Maaş',
  type: 'Tür',
};

function event(actor, category, action, area, record_ref = null, fieldNames = []) {
  return {
    category,
    action,
    area,
    record_ref,
    fields: fieldNames,
    actor_id: actor?.id || null,
    actor_name: actor?.name || null,
    actor_username: actor?.username || null,
  };
}

function reference(row, area) {
  if (area === 'Kullanıcı Yönetimi') return row.username;
  if (area === 'Evraklar' && /^[A-ZÇĞİÖŞÜ]{1,12}-[0-9]{1,12}$/i.test(row.number || '')) return row.number;
  return /^[a-zA-Z0-9_-]{1,80}$/.test(row.id || '') ? row.id : null;
}

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [
    ...new Set(
      [...keys]
        .filter((key) => !isDeepStrictEqual(before?.[key], after?.[key]))
        .map((key) => (Object.hasOwn(fields, key) ? fields[key] : 'Diğer alanlar')),
    ),
  ];
}

function dataEvents(actor, before, after) {
  if (!before || !after || before === after) return [];
  const out = [];
  const compare = (area, oldRows, newRows) => {
    const byId = (rows) =>
      new Map(
        (Array.isArray(rows) ? rows : [])
          .filter((row) => row?.id && !(area === 'Mesajlar' && row.systemType))
          .map((row) => [row.id, row]),
      );
    const old = byId(oldRows),
      next = byId(newRows);
    for (const [id, row] of next) {
      if (!old.has(id)) out.push(event(actor, 'changes', 'create', area, reference(row, area)));
      else if (!isDeepStrictEqual(old.get(id), row))
        out.push(
          event(actor, 'changes', 'update', area, reference(row, area), changedFields(old.get(id), row)),
        );
    }
    for (const [id, row] of old)
      if (!next.has(id)) out.push(event(actor, 'changes', 'delete', area, reference(row, area)));
  };
  const a = before.data || {},
    b = after.data || {};
  compare('Kullanıcı Yönetimi', before.users, after.users);
  compare('Müvekkiller', a['icrapro-v1']?.clients, b['icrapro-v1']?.clients);
  compare('Evraklar', a['icrapro-v1']?.docs, b['icrapro-v1']?.docs);
  compare('Personel', a['icrapro-personnel-v1'], b['icrapro-personnel-v1']);
  compare('Finans', a['hanhukuk-finance-v1'], b['hanhukuk-finance-v1']);
  compare('Muhasebe Hesapları', a['hanhukuk-accounting-v1']?.accounts, b['hanhukuk-accounting-v1']?.accounts);
  compare('Muhasebe Hareketleri', a['hanhukuk-accounting-v1']?.entries, b['hanhukuk-accounting-v1']?.entries);
  compare('Dava Takibi', a['icrapro-cases-v1'], b['icrapro-cases-v1']);
  compare('Mesajlar', before.messages, after.messages);
  compare('İş Emirleri', before.workOrders, after.workOrders);
  compare('Günlük Primler', before.dailyBonuses, after.dailyBonuses);
  for (const [area, old, next] of [
    ['Firma Ayarları', a['icrapro-settings-v1'], b['icrapro-settings-v1']],
    ['Bordro', before.payrollPeriods, after.payrollPeriods],
    ['İş Akışı Bildirimleri', before.workflowNotices, after.workflowNotices],
    ['Tahsilat Bildirimleri', before.collectionNotices, after.collectionNotices],
  ])
    if (!isDeepStrictEqual(old, next))
      out.push(
        event(
          actor,
          'changes',
          'update',
          area,
          null,
          area === 'Firma Ayarları' ? changedFields(old, next) : [],
        ),
      );
  if (!out.length && !isDeepStrictEqual(before, after))
    out.push(event(actor, 'changes', 'update', 'Uygulama Kayıtları'));
  return out;
}

function requestEvents(req, url, raw, response) {
  const { before, after, actor: sessionActor } = response.hanAudit || {};
  const actor = response.hanAuditActor || sessionActor;
  const ok = response.statusCode >= 200 && response.statusCode < 300;
  if (req.method === 'POST' && url.pathname === '/api/login' && before) {
    if (ok) return [event(JSON.parse(response.body), 'login', 'login', 'Oturum')];
    if ([401, 429].includes(response.statusCode)) {
      let attempted;
      try {
        const username = String(JSON.parse(raw.toString()).username || '')
          .trim()
          .toLocaleLowerCase('tr');
        attempted = before.users.find((user) => user.username === username);
      } catch {
        /* Unknown account. */
      }
      return [event(attempted, 'failed', response.statusCode === 429 ? 'blocked' : 'failed', 'Oturum')];
    }
  }
  if (!ok) return [];
  if (req.method === 'POST' && url.pathname === '/api/logout' && actor)
    return [event(actor, 'logout', 'logout', 'Oturum')];
  if (req.method === 'POST' && url.pathname === '/api/setup' && after?.users.length)
    return [event(after.users[0], 'changes', 'create', 'Kullanıcı Yönetimi', after.users[0].username)];
  if (!actor) return [];
  if (url.pathname === '/api/ceo-pin/verify') return [];
  if (url.pathname === '/api/ceo-pin/config')
    return [event(actor, 'changes', 'update', 'Güvenlik PIN’i', null, ['PIN ve korunan alanlar'])];
  if (url.pathname.startsWith('/api/employee-terms/')) {
    const terms = response.hanEmployeeTermsAudit;
    return terms ? [event(actor, 'changes', terms.action, 'Gizlilik Sözleşmesi', terms.version)] : [];
  }
  if (url.pathname === '/api/scheduled-reminders') {
    const reminder = response.hanReminderAudit;
    return reminder ? [event(actor, 'changes', reminder.action, 'Hatırlatmalar', reminder.id)] : [];
  }
  if (url.pathname === '/api/whatsapp/config' && req.method === 'PUT')
    return [event(actor, 'changes', 'update', 'WhatsApp Business', null, ['Bağlantı ayarları'])];
  const entries = dataEvents(actor, before, after);
  if (url.pathname === '/api/documents/restore')
    for (const row of entries) if (row.area === 'Evraklar' && row.action === 'create') row.action = 'restore';
  return entries;
}

function auditQuery(params) {
  const category = params.get('category') || 'changes';
  const action = params.get('action') || '';
  const cursor = params.get('cursor') || '';
  const actor = (params.get('actor') || '').trim();
  const bad = () => Object.assign(new Error('Geçerli kayıt filtreleri seçin.'), { status: 400 });
  if (
    !categories.has(category) ||
    (action && (category !== 'changes' || !actions.has(action))) ||
    (cursor && (!/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)) ||
    actor.length > 80
  )
    throw bad();
  const date = (value) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad();
    const utc = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) throw bad();
    return utc - 3 * 3600000;
  };
  const from = date(params.get('from')),
    through = date(params.get('to'));
  if (from !== null && through !== null && from > through) throw bad();
  return {
    category,
    action,
    cursor,
    actor,
    from: from === null ? null : new Date(from).toISOString(),
    until: through === null ? null : new Date(through + 86400000).toISOString(),
  };
}

function page(rows) {
  const items = rows.slice(0, PAGE_SIZE);
  return { items, next: rows.length > PAGE_SIZE ? items.at(-1).id : null };
}

function createLocalAuditStore(stateFile) {
  const file = path.join(path.dirname(stateFile), 'audit-events.jsonl');
  let queue = Promise.resolve();
  return {
    appendAudit(events) {
      if (!events.length) return;
      const at = new Date().toISOString();
      const next = queue.then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, events.map((entry) => JSON.stringify({ ...entry, at })).join('\n') + '\n', {
          mode: 0o600,
        });
      });
      queue = next.catch(() => {});
      return next;
    },
    async listAudit(query) {
      let body;
      try {
        body = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return page([]);
        throw error;
      }
      const lines = body.trimEnd().split('\n');
      const rows = [];
      const needle = query.actor.toLocaleLowerCase('tr');
      for (let i = lines.length - 1; i >= 0 && rows.length <= PAGE_SIZE; i--) {
        if (!lines[i] || (query.cursor && BigInt(i + 1) >= BigInt(query.cursor))) continue;
        const row = JSON.parse(lines[i]);
        if (
          row.category !== query.category ||
          (query.action && row.action !== query.action) ||
          (query.from && row.at < query.from) ||
          (query.until && row.at >= query.until) ||
          (needle &&
            ![row.actor_name, row.actor_username].some((value) =>
              value?.toLocaleLowerCase('tr').includes(needle),
            ))
        )
          continue;
        rows.push({ id: String(i + 1), ...row });
      }
      return page(rows);
    },
  };
}

module.exports = { PAGE_SIZE, event, requestEvents, auditQuery, page, createLocalAuditStore };

const { handleSessionRoutes, handleAccountRoutes } = require('./access-accounts.cjs');
const { handleEmployeeTermsRoutes } = require('./access-employee-terms.cjs');
const { handleScheduledReminderRoutes } = require('./access-scheduled-reminders.cjs');
const { requiresEmployeeTerms, REQUIRED_MESSAGE } = require('../../lib/employee-terms.cjs');
const { searchWorkspace } = require('../../lib/workspace-search.cjs');
const { handleWhatsAppRoutes } = require('./access-whatsapp.cjs');
const {
  activeArchives,
  archiveRemovedDocuments,
  preventArchivedNumberReuse,
} = require('../../lib/document-archive.cjs');
const { handleWorkflowRoutes } = require('./access-workflow.cjs');
const { handleDocumentRoutes } = require('./access-documents.cjs');
const { handleCommunicationRoutes } = require('./access-communications.cjs');
const { handlePersonnelRoutes } = require('./access-personnel.cjs');
const { handleDataRoutes } = require('./access-data.cjs');
const { recognizedCollectionRevenue } = require('./profit-rules.js');
const { syncPayrollPeriods } = require('./payroll-periods.cjs');
const { normalizePhoneRecords } = require('./phone-format.js');
const { applyAutomaticLegalCharges } = require('./legal-charges.cjs');
const { isCallcenter, calculateCallcenterBonus } = require('./personnel-bonus.cjs');
const { duplicateIdentityError } = require('./identity-validation.cjs');
const { runWorkflowAutomation, promiseOutstanding } = require('./workflow-automation.cjs');
const { applyParkingFee } = require('./parking-fees.js');
const parkingToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const permissions = ['clients', 'documents', 'cashIn', 'cashOut'];
const dataKeys = [
  'icrapro-v1',
  'icrapro-personnel-v1',
  'icrapro-settings-v1',
  'hanhukuk-finance-v1',
  'hanhukuk-accounting-v1',
  'icrapro-cases-v1',
];
const defaults = {
  'icrapro-v1': { clients: [], docs: [] },
  'icrapro-personnel-v1': [],
  'icrapro-settings-v1': {},
  'hanhukuk-finance-v1': [],
  'hanhukuk-accounting-v1': { accounts: [{ id: 'cash', name: 'Nakit Kasa', type: 'cash' }], entries: [] },
  'icrapro-cases-v1': [],
};
function createAccess(stateFile, options = {}) {
  let state = options.initialState || { users: [], data: structuredClone(defaults) };
  if (!options.initialState && stateFile && fs.existsSync(stateFile))
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const sessions = options.sessions || new Map(),
    attempts = options.attempts || new Map();
  const secure = options.secureCookies ? '; Secure' : '';
  const revision = (key) =>
    '\"' + crypto.createHash('sha256').update(JSON.stringify(state.data[key])).digest('hex') + '\"';
  function saveState(next) {
    if (options.saveState) options.saveState(next);
    else {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(stateFile + '.tmp', stateFile);
    }
    state = next;
  }
  function persist(next, actor) {
    if (actor) archiveRemovedDocuments(state, next, actor);
    delete next.data['icrapro-v1'].archivedNumbers;
    preventArchivedNumberReuse(state, next);
    normalizePhoneRecords(next.data);
    syncPayrollPeriods(next, parkingToday());
    for (const d of next.data['icrapro-v1'].docs) {
      if (
        ['Senet', 'Diğer'].includes(d.docType) &&
        (d.originalAmount != null || d.preTrackingPayment != null)
      ) {
        const [total, paid, principal] = [d.originalAmount, d.preTrackingPayment, d.amount].map((value) =>
          Math.round(Number(value) * 100),
        );
        if (
          ![total, paid, principal].every(Number.isSafeInteger) ||
          paid < 0 ||
          principal < 0 ||
          total - paid !== principal
        ) {
          throw Object.assign(new Error('Evrak tutarı ve takip öncesi ödeme uyumsuz.'), { code: 400 });
        }
      }
      applyAutomaticLegalCharges(d, next.data['hanhukuk-finance-v1'], parkingToday());
      const previous = state.data['icrapro-v1'].docs.find((x) => x.id === d.id);
      const stamp = previous?.created ? new Date(previous.created) : null;
      d.trackingDate =
        previous?.trackingDate ||
        (stamp && Number.isFinite(stamp.getTime())
          ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(stamp)
          : parkingToday());
      const payments = next.data['hanhukuk-finance-v1'].filter(
          (e) => e.documentId === d.id && e.type === 'payment',
        ),
        received = payments.reduce((sum, e) => sum + Number(e.amount || 0), 0),
        parking = d.docType === 'Yediemin Park Ücreti',
        total = Math.max(
          0,
          Math.round(Number(d.amount || 0) * 100) +
            (parking
              ? 0
              : Math.round(Number(d.financeInterest || 0) * 100) +
                Math.round(Number(d.financeFee || 0) * 100) +
                next.data['hanhukuk-finance-v1']
                  .filter((e) => e.documentId === d.id && e.type === 'expense')
                  .reduce((sum, e) => sum + Number(e.amount || 0), 0)) -
            Number(d.debtDiscountCents || 0),
        );
      if (total > 0 && received >= total) {
        d.status = 'İnfaz';
        d.closedDate =
          d.closedDate ||
          payments
            .map((e) => e.date)
            .sort()
            .at(-1);
      } else if (String(d.enforcementFileNumber || '').trim() && (!d.status || d.status === 'Derdest'))
        d.status = 'İcra';
    }
    const duplicate = duplicateIdentityError(next.data['icrapro-v1'], state.data['icrapro-v1']);
    if (duplicate) throw Object.assign(Error(duplicate), { code: 409 });
    saveState(next);
  }
  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    staffId: u.staffId || '',
    permissions: ['ceo', 'admin'].includes(u.role) ? permissions : u.permissions,
    active: u.active,
  });
  function hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }
  function passwordOK(password, u) {
    return (
      typeof password === 'string' &&
      crypto.timingSafeEqual(Buffer.from(hash(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))
    );
  }
  function userEnabled(u) {
    return (
      !!u &&
      u.active &&
      (!u.staffId || state.data['icrapro-personnel-v1'].some((p) => p.id === u.staffId && p.active !== false))
    );
  }
  function current(req) {
    const token = (req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('han_session='))
        ?.slice(12),
      session = sessions.get(token ? crypto.createHash('sha256').update(token).digest('hex') : '');
    if (!session || session.until < Date.now()) return null;
    session.seenAt = Date.now();
    return state.users.find((u) => u.id === session.id && userEnabled(u)) || null;
  }
  function login(res, u, { remember = false } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const lifetime = remember ? 14 * 24 * 3600000 : 8 * 3600000;
    sessions.set(crypto.createHash('sha256').update(token).digest('hex'), {
      id: u.id,
      until: Date.now() + lifetime,
      seenAt: Date.now(),
    });
    const maxAge = remember ? '; Max-Age=' + lifetime / 1000 : '';
    res.setHeader(
      'Set-Cookie',
      'han_session=' + token + '; HttpOnly; SameSite=Strict; Path=/' + maxAge + secure,
    );
  }
  function invalidate(id) {
    for (const [key, s] of sessions) if (s.id === id) sessions.delete(key);
  }
  function allowed(u, p) {
    return ['ceo', 'admin'].includes(u.role) || p === 'documents' || u.permissions.includes(p);
  }
  const fail = (code, message) => Object.assign(Error(message), { code });
  async function body(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > (options.maxBodyBytes || 25 * 1024 * 1024))
        throw fail(413, 'İstek çok büyük.');
    }
    try {
      return JSON.parse(raw || '{}');
    } catch {
      throw fail(400, 'Geçersiz veri.');
    }
  }
  function send(res, code, value) {
    if (res.hanAudit) res.hanAudit.after = state;
    if (res.hanDataKey) res.setHeader('ETag', revision(res.hanDataKey));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function newUser(v) {
    const username = String(v.username || '')
        .trim()
        .toLocaleLowerCase('tr'),
      name = String(v.name || '').trim();
    if (
      !name ||
      !username ||
      username.length > 60 ||
      typeof v.password !== 'string' ||
      v.password.length < 10
    )
      throw fail(400, 'Ad, kullanıcı adı ve en az 10 karakterli şifre girin.');
    if (state.users.some((u) => u.username === username)) throw fail(400, 'Kullanıcı adı kullanılıyor.');
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      id: crypto.randomUUID(),
      username,
      name,
      salt,
      hash: hash(v.password, salt),
      role: ['ceo', 'admin'].includes(v.role) ? v.role : 'staff',
      staffId: v.staffId || '',
      permissions: (v.permissions || []).filter((p) => permissions.includes(p)),
      active: true,
    };
  }
  function readKey(key, u) {
    const value = structuredClone(state.data[key] ?? defaults[key]);
    if (key === 'icrapro-v1') {
      value.docs.forEach((d) => applyParkingFee(d, parkingToday()));
      value.archivedNumbers = activeArchives(state)
        .map((entry) => entry.document.number)
        .filter(Boolean);
    }
    if (
      ['ceo', 'admin'].includes(u.role) ||
      ['icrapro-v1', 'hanhukuk-finance-v1', 'hanhukuk-accounting-v1'].includes(key)
    )
      return value;
    if (key === 'icrapro-v1') {
      const d = value;
      const docs = allowed(u, 'documents')
        ? d.docs.map((doc) => {
            const next = { ...doc };
            if (!u.staffId || u.staffId !== doc.relatedStaff) {
              delete next.paymentPromise;
              delete next.paymentPromiseHistory;
            }
            for (const k of [
              'financeInterest',
              'financeFee',
              'legalCalculation',
              'debtDiscountCents',
              'discountHistory',
              'repaymentPlan',
              'repaymentPlanHistory',
              'clientPaidAmount',
            ])
              delete next[k];
            return next;
          })
        : [];
      const clients = allowed(u, 'clients')
        ? d.clients
        : d.clients.map((c) => ({ id: c.id, name: c.name, type: c.type, identity: c.identity }));
      return { clients: allowed(u, 'clients') || allowed(u, 'documents') ? clients : [], docs };
    }
    if (key === 'icrapro-personnel-v1')
      return value.map((p) => ({
        id: p.id,
        name: p.name,
        title: p.title,
        department: p.department,
        active: p.active,
      }));
    if (key === 'icrapro-settings-v1') return { firm: { name: value.firm?.name || 'Hukuk Bürosu' } };
    if (key === 'hanhukuk-accounting-v1')
      return { accounts: value.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })), entries: [] };
    return [];
  }
  function ledgerBalance(id) {
    const ledger = state.data['hanhukuk-accounting-v1'];
    let n = 0;
    for (const e of ledger.entries) {
      if (e.accountId === id) n += e.type === 'in' ? e.amount : -e.amount;
      if (e.type === 'transfer' && e.destination === id) n += e.amount;
    }
    for (const e of state.data['hanhukuk-finance-v1'])
      if (e.accountId === id) n += e.type === 'payment' ? e.amount : -e.amount;
    return n;
  }
  if (options.timers !== false) {
    const automationTimer = setInterval(() => {
      try {
        const next = structuredClone(state);
        if (runWorkflowAutomation(next, parkingToday())) persist(next);
      } catch (error) {
        console.error('Dosya otomasyonu çalıştırılamadı.');
      }
    }, 60000);
    automationTimer.unref();
  }
  async function access(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      if (
        req.method !== 'GET' &&
        (req.headers['x-han-request'] !== '1' ||
          (req.headers.origin && req.headers.origin !== (options.appOrigin || 'http://' + req.headers.host)))
      )
        throw fail(403, 'İstek kaynağı doğrulanamadı.');
      const u = current(req);
      const termsRequired = requiresEmployeeTerms(state, u);
      if (
        u &&
        !termsRequired &&
        url.pathname !== '/api/search' &&
        url.pathname !== '/api/scheduled-reminders' &&
        !url.pathname.startsWith('/api/employee-terms/')
      ) {
        const next = structuredClone(state),
          payrollChanged = syncPayrollPeriods(next, parkingToday()),
          workflowChanged = runWorkflowAutomation(next, parkingToday());
        if (payrollChanged || workflowChanged) persist(next);
      }
      if (options.audit && req.method !== 'GET')
        res.hanAudit = { actor: u ? publicUser(u) : null, before: state };
      const ctx = {
        req,
        res,
        url,
        u,
        options,
        sessions,
        attempts,
        persist: (next) => persist(next, u),
        persistEmployeeTerms: saveState,
        persistMetadata: saveState,
        publicUser,
        passwordOK,
        userEnabled,
        login,
        fail,
        body,
        send,
        newUser,
        crypto,
        dataKeys,
        allowed,
        parkingToday,
        promiseOutstanding,
        current,
        applyParkingFee,
        hash,
        invalidate,
        permissions,
        isCallcenter,
        calculateCallcenterBonus,
        recognizedCollectionRevenue,
        secure,
        revision,
        readKey,
        ledgerBalance,
        get state() {
          return state;
        },
      };
      if (await handleSessionRoutes(ctx)) return true;
      if (await handleEmployeeTermsRoutes(ctx)) return true;
      if (
        ['/api/password-reset/request', '/api/password-reset/complete'].includes(url.pathname) &&
        (await handleWhatsAppRoutes(ctx))
      )
        return true;
      if (termsRequired && url.pathname !== '/api/logout') {
        send(res, 428, { error: REQUIRED_MESSAGE, code: 'employee_terms_required' });
        return true;
      }
      if (await handleWhatsAppRoutes(ctx)) return true;
      if (!u) throw fail(401, 'Giriş yapın.');
      if (await handleScheduledReminderRoutes(ctx)) return true;
      if (url.pathname === '/api/search' && req.method === 'GET') {
        send(res, 200, { items: searchWorkspace(state, u, url.searchParams.get('q')) });
        return true;
      }
      if (await handleWorkflowRoutes(ctx)) return true;
      if (await handleDocumentRoutes(ctx)) return true;
      if (await handleCommunicationRoutes(ctx)) return true;
      if (await handlePersonnelRoutes(ctx)) return true;
      if (await handleAccountRoutes(ctx)) return true;
      if (await handleDataRoutes(ctx)) return true;
      throw fail(404, 'İşlem bulunamadı.');
    } catch (error) {
      send(res, error.code || 500, { error: error.code ? error.message : 'Sunucu işlemi tamamlayamadı.' });
    }
    return true;
  }
  access.metadataTransaction = (work) => work({ state: structuredClone(state), saveState });
  return access;
}
module.exports = { createAccess };

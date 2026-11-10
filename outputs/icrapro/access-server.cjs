const { handleSessionRoutes, handleAccountRoutes } = require('./access-accounts.cjs');
const { handleEmployeeTermsRoutes } = require('./access-employee-terms.cjs');
const { handleScheduledReminderRoutes } = require('./access-scheduled-reminders.cjs');
const { requiresEmployeeTerms, REQUIRED_MESSAGE } = require('../../lib/employee-terms.cjs');
const {
  sessionKey,
  sessionCookie,
  requestDeviceType,
  sessionIsValid,
} = require('../../lib/session-policy.cjs');
const { mutationSourceAllowed, secureCookiesRequired } = require('../../lib/request-security.cjs');
const {
  hashPassword: hash,
  verifyPassword: passwordOK,
  passwordValid,
} = require('../../lib/password-policy.cjs');
const { searchWorkspace } = require('../../lib/workspace-search.cjs');
const { notificationSummary } = require('../../lib/notification-summary.cjs');
const { handleWhatsAppRoutes } = require('./access-whatsapp.cjs');
const { handleAiRoutes } = require('./access-ai.cjs');
const { activeArchives } = require('../../lib/document-archive.cjs');
const { prepareState } = require('../../lib/state-invariants.cjs');
const { handleWorkflowRoutes } = require('./access-workflow.cjs');
const { handleDocumentRoutes } = require('./access-documents.cjs');
const { handleCommunicationRoutes } = require('./access-communications.cjs');
const { handlePersonnelRoutes } = require('./access-personnel.cjs');
const { handleBreakRoutes } = require('./access-breaks.cjs');
const { handleDataRoutes } = require('./access-data.cjs');
const { handleDeletionRoutes } = require('./access-deletion.cjs');
const { canDelete } = require('../../lib/deletion-policy.cjs');
const { accountingStaff } = require('../../lib/accounting-access.cjs');
const { recognizedCollectionRevenue } = require('./profit-rules.js');
const { syncPayrollPeriods } = require('./payroll-periods.cjs');
const { isCallcenter, calculateCallcenterBonus } = require('./personnel-bonus.cjs');
const { runWorkflowAutomation, promiseOutstanding } = require('./workflow-automation.cjs');
const { applyParkingFee } = require('./parking-fees.js');
const { businessDate: parkingToday } = require('../../lib/business-time.cjs');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readOnlyDenied, MESSAGE: READ_ONLY_MESSAGE } = require('../../lib/read-only-account.cjs');
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
  options = { ...options, secureCookies: secureCookiesRequired(options) };
  let state = options.initialState || { users: [], data: structuredClone(defaults) };
  if (!options.initialState && stateFile && fs.existsSync(stateFile))
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const sessions = options.sessions || new Map(),
    attempts = options.attempts || new Map();
  const clearSessionCookie = (res) =>
    res.setHeader('Set-Cookie', sessionCookie('', { secure: options.secureCookies, maxAge: 0 }));
  const revision = (key) =>
    '\"' + crypto.createHash('sha256').update(JSON.stringify(state.data[key])).digest('hex') + '\"';
  function saveState(next) {
    if (options.readOnly) throw new Error('Read-only request attempted a state mutation');
    if (options.saveState) options.saveState(next);
    else {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(stateFile + '.tmp', stateFile);
    }
    state = next;
  }
  function persist(next, actor) {
    prepareState(state, next, actor, { skipPayroll: options.skipPayroll === true });
    saveState(next);
  }
  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    staffId: u.staffId || '',
    marketingAccess:
      ['ceo', 'admin'].includes(u.role) ||
      state.data['icrapro-personnel-v1'].some(
        (p) =>
          p.id === u.staffId &&
          p.active !== false &&
          String(p.department || '')
            .trim()
            .toLocaleLowerCase('tr-TR') === 'pazarlama',
      ),
    permissions: ['ceo', 'admin'].includes(u.role) ? permissions : u.permissions,
    accountingAccess: accountingStaff(u, state.data['icrapro-personnel-v1']),
    active: u.active,
    readOnly: u.role !== 'ceo' && u.readOnly === true,
    testAccount: u.testAccount === true,
    canDelete: (u.role === 'ceo' || u.readOnly !== true) && canDelete(u),
    activeBreak: u.role === 'ceo' ? null : u.activeBreak || null,
  });
  function userEnabled(u) {
    if (options.userEnabled) return options.userEnabled(u);
    return (
      !!u &&
      u.active &&
      (!u.staffId || state.data['icrapro-personnel-v1'].some((p) => p.id === u.staffId && p.active !== false))
    );
  }
  function current(req) {
    const session = sessions.get(sessionKey(req));
    const now = Date.now();
    if (!sessionIsValid(session, now)) return null;
    session.seenAt = now;
    return state.users.find((u) => u.id === session.id && userEnabled(u)) || null;
  }
  function login(req, res, u, { remember = false, replaceSessions = false } = {}) {
    const deviceType = requestDeviceType(req);
    const now = Date.now();
    if (!replaceSessions) {
      for (const session of sessions.values()) {
        if (session.id === u.id && session.deviceType === deviceType && sessionIsValid(session, now))
          return false;
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    const lifetime = remember ? 14 * 24 * 3600000 : 8 * 3600000;
    if (replaceSessions) invalidate(u.id);
    sessions.set(crypto.createHash('sha256').update(token).digest('hex'), {
      id: u.id,
      deviceType,
      until: now + lifetime,
      seenAt: now,
    });
    res.setHeader(
      'Set-Cookie',
      sessionCookie(token, { secure: options.secureCookies, maxAge: remember ? lifetime / 1000 : undefined }),
    );
    return true;
  }
  function invalidate(id) {
    for (const [key, s] of sessions) if (s.id === id) sessions.delete(key);
  }
  function allowed(u, p) {
    return (
      ['ceo', 'admin'].includes(u.role) ||
      p === 'documents' ||
      (['cashIn', 'cashOut'].includes(p) && accountingStaff(u, state.data['icrapro-personnel-v1'])) ||
      u.permissions.includes(p)
    );
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
  async function newUser(v) {
    const username = String(v.username || '')
        .trim()
        .toLocaleLowerCase('tr'),
      name = String(v.name || '').trim();
    if (!name || !username || username.length > 60 || !passwordValid(v.password))
      throw fail(400, 'Ad, kullanıcı adı ve en az 10 karakterli şifre girin.');
    if (state.users.some((u) => u.username === username)) throw fail(400, 'Kullanıcı adı kullanılıyor.');
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      id: crypto.randomUUID(),
      username,
      name,
      salt,
      hash: await hash(v.password, salt),
      role: ['ceo', 'admin'].includes(v.role) ? v.role : 'staff',
      staffId: v.staffId || '',
      permissions: (v.permissions || []).filter((p) => permissions.includes(p)),
      active: true,
      readOnly: v.readOnly === true,
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
      if (
        e.accountId === id &&
        ['payment', 'expense', 'costOnly'].includes(e.type) &&
        !(ledger.excludedFinanceIds || []).includes(e.id)
      )
        n += e.type === 'payment' ? e.amount : -e.amount;
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
      if (!mutationSourceAllowed(req, options)) throw fail(403, 'İstek kaynağı doğrulanamadı.');
      const u = current(req);
      if (readOnlyDenied(u, req.method, url.pathname)) throw fail(403, READ_ONLY_MESSAGE);
      if (
        u?.activeBreak &&
        u.role !== 'ceo' &&
        ![
          '/api/staff-breaks',
          '/api/logout',
          '/api/login',
          '/api/presence',
          '/api/session',
          '/api/notifications',
          '/api/employee-terms/current',
        ].includes(url.pathname)
      ) {
        send(res, 423, {
          error: 'Moladasınız. İşlem yapabilmek için önce molayı bitirin.',
          code: 'staff_on_break',
          activeBreak: u.activeBreak,
        });
        return true;
      }
      const termsRequired =
        u?.role === 'ceo'
          ? false
          : options.employeeTermsRequired
            ? options.employeeTermsRequired(u)
            : requiresEmployeeTerms(state, u);
      if (
        u &&
        !u.readOnly &&
        !termsRequired &&
        !options.skipAutomations &&
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
        termsRequired,
        sessions,
        attempts,
        persist: (next) => persist(next, u),
        persistEmployeeTerms: saveState,
        persistMetadata: saveState,
        publicUser,
        passwordOK,
        userEnabled,
        login,
        sessionIsValid,
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
        clearSessionCookie,
        revision,
        readKey,
        ledgerBalance,
        get state() {
          return state;
        },
      };
      if (await handleSessionRoutes(ctx)) return true;
      if (u?.activeBreak && url.pathname === '/api/staff-breaks' && (await handleBreakRoutes(ctx)))
        return true;
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
      if (await require('./access-ceo-pin.cjs').handleCeoPin(ctx)) return true;
      if (await handleAiRoutes(ctx)) return true;
      if (url.pathname === '/api/notifications' && req.method === 'GET') {
        send(res, 200, notificationSummary(state, u, url.searchParams.get('after')));
        return true;
      }
      if (await handleScheduledReminderRoutes(ctx)) return true;
      if (url.pathname === '/api/search' && req.method === 'GET') {
        send(res, 200, { items: searchWorkspace(state, u, url.searchParams.get('q')) });
        return true;
      }
      if (await handleWorkflowRoutes(ctx)) return true;
      if (await handleDeletionRoutes(ctx)) return true;
      if (await handleDocumentRoutes(ctx)) return true;
      if (await handleCommunicationRoutes(ctx)) return true;
      if (await handleBreakRoutes(ctx)) return true;
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
  access.runMaintenance = () => {
    const next = structuredClone(state);
    const payrollChanged = options.skipPayroll ? false : syncPayrollPeriods(next, parkingToday());
    const workflowChanged = runWorkflowAutomation(next, parkingToday(), undefined, options.workflowRanking);
    if (payrollChanged || workflowChanged) persist(next);
    return payrollChanged || workflowChanged;
  };
  return access;
}
module.exports = { createAccess };

const { mutationSourceAllowed } = require('./request-security.cjs');
const { attemptKey } = require('./session-policy.cjs');
const auth = require('./saas/platform-auth.cjs');
const platform = require('./saas/platform.cjs');
const campaigns = require('./saas/campaigns.cjs');
const announcements = require('./saas/announcements.cjs');
const pipeline = require('./saas/pipeline.cjs');
const profit = require('./saas/profit.cjs');
const supportAccess = require('./saas/support-access.cjs');
const { LEGACY_TENANT_ID } = require('./saas/tenant-pool.cjs');
const support = require('./saas/support.cjs');
const finance = require('./saas/finance.cjs');
const online = require('./saas/online-payments.cjs');
const account = require('./saas/platform-account.cjs');
const platformSms = require('./saas/platform-sms.cjs');
const officeRecovery = require('./saas/office-recovery.cjs');

const MAX_BODY = 64 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  let raw;
  if (req.body !== undefined) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  else {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk);
      if (length > MAX_BODY) throw fail(413, 'İstek çok büyük.');
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > MAX_BODY) throw fail(413, 'İstek çok büyük.');
  if (!raw.trim()) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw fail(400, 'Geçersiz istek.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Geçersiz istek.');
  return value;
}

// Operator-only API served on the platform host (admin.<base domain>). It has its own
// accounts, sessions and cookie; an office session can never reach it and it never
// touches office data, only the control plane.
// `iyzico` (optional) is a lib/iyzico.cjs client for the platform's own merchant account.
// `requireTotp`: operators without two-factor sign-in may only reach their own account page
// (to set it up) until they enable it. true = always, false = never, 'sms' (the default) =
// only once platform SMS (Verimor) is set up and switched on in Yönetim → SMS.
// `smsFetch`: fetch used for Verimor SMS calls (tests replace it).
function createPlatformHandler({ pool, appOrigin, secureCookies = true, iyzico = null, requireTotp = 'sms', smsFetch }) {
  const security = { appOrigin, secureCookies };
  // The office's own address for a support access link: <slug>.<base domain> (the console runs
  // on admin.<base domain>); the existing office lives on the base domain itself. Without a
  // configured origin (local preview) only the path is returned.
  const officeUrl = ({ tenantId, slug, path }) => {
    const base = appOrigin ? new URL(appOrigin).host.replace(/^admin\./, '') : null;
    if (!base) return path;
    return `https://${tenantId === LEGACY_TENANT_ID ? '' : slug + '.'}${base}${path}`;
  };
  const smsStatus = platformSms.createPlatformSms(pool);
  const totpRequired = async () => (requireTotp === 'sms' ? smsStatus.available() : requireTotp === true);

  // [method, pattern, handler(ctx)]; handlers get the verified operator and parsed body.
  const routes = [
    ['GET', /^dashboard$/, async () => ({ ...(await platform.dashboard(pool)), onlinePaymentsConfigured: !!iyzico })],
    ['GET', /^modules$/, () => platform.listModules(pool)],
    ['POST', /^modules$/, ({ admin, body }) => platform.upsertModule(pool, body, admin.id)],
    ['GET', /^campaigns$/, async () => ({ campaigns: await campaigns.listCampaigns(pool) })],
    ['POST', /^campaigns$/, ({ admin, body }) => campaigns.upsertCampaign(pool, admin.id, body)],
    ['POST', /^campaigns\/quote$/, ({ body }) => campaigns.quote(pool, body)],
    ['POST', /^campaigns\/([^/]+)\/status$/, ({ admin, body, match }) =>
      campaigns.setCampaignStatus(pool, admin.id, { id: match[1], status: body.status })],
    ['GET', /^announcements$/, async () => ({ announcements: await announcements.listAnnouncements(pool) })],
    ['POST', /^announcements$/, ({ admin, body }) => announcements.upsertAnnouncement(pool, admin.id, body)],
    ['POST', /^announcements\/([^/]+)\/status$/, ({ admin, body, match }) =>
      announcements.setAnnouncementStatus(pool, admin.id, { id: match[1], status: body.status })],
    ['GET', /^prospects$/, ({ query }) =>
      pipeline.listProspects(pool, {
        stage: query.get('stage') || undefined,
        source: query.get('source') || undefined,
        owner: query.get('owner') || undefined,
        q: query.get('q') || undefined,
      })],
    ['POST', /^prospects$/, ({ admin, body }) => pipeline.createProspect(pool, admin.id, body)],
    ['GET', /^prospects\/([^/]+)$/, ({ match }) => pipeline.prospectDetail(pool, match[1])],
    ['POST', /^prospects\/([^/]+)$/, ({ admin, body, match }) => pipeline.updateProspect(pool, admin.id, { ...body, id: match[1] })],
    ['POST', /^prospects\/([^/]+)\/stage$/, ({ admin, body, match }) =>
      pipeline.moveProspect(pool, admin.id, { id: match[1], stage: body.stage, lostReason: body.lostReason })],
    ['POST', /^prospects\/([^/]+)\/notes$/, ({ admin, body, match }) =>
      pipeline.addProspectNote(pool, admin.id, { id: match[1], body: body.body })],
    ['POST', /^offices\/([^/]+)\/modules\/trial$/, ({ admin, body, match }) =>
      platform.startTrial(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices\/([^/]+)\/products\/sell$/, ({ admin, body, match }) => platform.sellProduct(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices$/, ({ admin, body }) => platform.openOffice(pool, admin.id, body)],
    ['GET', /^offices\/([^/]+)$/, async ({ match }) => ({ ...(await platform.officeDetail(pool, { tenantId: match[1] })), payments: await online.listPayments(pool, match[1]) })],
    ['POST', /^offices\/([^/]+)\/payment-link$/, ({ admin, body, match, req }) =>
      online.createPaymentLink(pool, admin.id, { ...body, tenantId: match[1] }, { iyzico, callbackUrl: callbackUrl(req), clientIp: clientIp(req) })],
    ['POST', /^offices\/([^/]+)\/users$/, ({ admin, body, match }) => platform.changeUsers(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices\/([^/]+)\/modules\/add$/, ({ admin, body, match }) => platform.addModule(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices\/([^/]+)\/modules\/remove$/, ({ admin, body, match }) => platform.removeModule(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices\/([^/]+)\/renew$/, ({ admin, body, match }) => platform.renewOffice(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices\/([^/]+)\/status$/, ({ admin, body, match }) => platform.setOfficeStatus(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^offices\/([^/]+)\/refund$/, ({ admin, body, match }) => platform.recordRefund(pool, admin.id, { ...body, tenantId: match[1] })],
    ['POST', /^sales\/([^/]+)\/paid$/, ({ admin, body, match }) => platform.markSalePaid(pool, admin.id, { ...body, saleId: match[1] })],
    ['POST', /^sales\/([^/]+)\/void$/, ({ admin, body, match }) => platform.voidSale(pool, admin.id, { ...body, saleId: match[1] })],
    ['GET', /^finance$/, async () => {
      await profit.postRecurringNow(pool);
      return finance.financeSummary(pool);
    }],
    ['GET', /^profit$/, ({ query }) =>
      profit.profitReport(pool, { from: query.get('from') || undefined, to: query.get('to') || undefined })],
    ['POST', /^settings\/unit-costs$/, ({ admin, body }) => profit.saveUnitCosts(pool, admin.id, body)],
    ['GET', /^recurring-expenses$/, async () => ({ recurring: await profit.listRecurring(pool) })],
    ['POST', /^recurring-expenses$/, ({ admin, body }) => profit.addRecurring(pool, admin.id, body)],
    ['POST', /^recurring-expenses\/([^/]+)\/stop$/, ({ admin, match }) => profit.stopRecurring(pool, admin.id, { id: match[1] })],
    ['GET', /^sales$/, ({ query }) => finance.salesReport(pool, { month: query.get('month') ?? undefined })],
    ['GET', /^expenses$/, async ({ query }) => {
      // Due recurring expenses are written before the month's list is read.
      await profit.postRecurringNow(pool);
      return finance.expensesReport(pool, { month: query.get('month') ?? undefined });
    }],
    ['POST', /^expenses$/, ({ admin, body }) => finance.addExpense(pool, admin.id, body)],
    ['POST', /^expenses\/([^/]+)\/void$/, ({ admin, body, match }) => finance.voidExpense(pool, admin.id, { ...body, expenseId: match[1] })],
    ['GET', /^account$/, async ({ admin }) => account.accountInfo(pool, admin.id, { requireTotp: await totpRequired() })],
    ['POST', /^account\/password$/, ({ admin, body, req }) =>
      account.changePassword(pool, admin.id, body, { keepTokenHash: auth.sessionTokenHash(req) })],
    ['POST', /^account\/totp\/start$/, ({ admin }) => account.startTotpSetup(pool, admin.id)],
    ['POST', /^account\/totp\/confirm$/, ({ admin, body }) => account.confirmTotpSetup(pool, admin.id, body)],
    ['POST', /^account\/totp\/disable$/, async ({ admin, body }) => account.disableTotp(pool, admin.id, body, { required: await totpRequired() })],
    ['GET', /^operators$/, async () => ({ operators: await account.listOperators(pool), audit: await account.listAudit(pool) })],
    ['POST', /^operators$/, ({ admin, body }) => account.addOperator(pool, admin.id, body)],
    ['POST', /^operators\/([^/]+)\/active$/, ({ admin, body, match }) =>
      account.setOperatorActive(pool, admin.id, { operatorId: match[1], active: body.active })],
    ['POST', /^operators\/([^/]+)\/reset-password$/, ({ admin, body, match }) =>
      account.resetOperatorPassword(pool, admin.id, { operatorId: match[1], password: body.password })],
    ['POST', /^operators\/([^/]+)\/reset-totp$/, ({ admin, match }) =>
      account.resetOperatorTotp(pool, admin.id, { operatorId: match[1] })],
    ['GET', /^settings\/sms$/, () => platformSms.getSettings(pool)],
    ['POST', /^settings\/sms$/, ({ admin, body }) => platformSms.saveSettings(pool, admin.id, body)],
    ['POST', /^settings\/sms\/test$/, ({ body }) => platformSms.testSettings(pool, body, { fetcher: smsFetch })],
    ['POST', /^settings\/sms\/send-test$/, async ({ admin, body }) => {
      const result = await platformSms.sendSms(
        pool,
        { to: body.phone, text: 'Hukuk Takip Platformu SMS denemesi. Bu mesaji aldiysaniz SMS ayarlari calisiyor.', purpose: 'test' },
        { fetcher: smsFetch, requireEnabled: false },
      );
      await account.record(pool, admin.id, 'settings.sms_test', null);
      return result;
    }],
    ['GET', /^offices\/([^/]+)\/managers$/, async ({ match }) => ({ managers: await officeRecovery.officeManagers(pool, match[1]) })],
    ['POST', /^offices\/([^/]+)\/managers\/reset$/, ({ admin, body, match }) =>
      officeRecovery.resetManager(pool, admin.id, { tenantId: match[1], userId: body.userId, mode: body.mode }, { fetcher: smsFetch })],
    ['GET', /^support$/, async () => ({ ...(await support.listTickets(pool)), access: await supportAccess.openAccessByTicket(pool) })],
    ['POST', /^support$/, ({ admin, body }) => support.openTicket(pool, admin.id, body)],
    ['GET', /^support\/([^/]+)$/, ({ match }) => support.ticketDetail(pool, { ticketId: match[1] })],
    ['POST', /^support\/([^/]+)\/messages$/, ({ admin, body, match }) => support.addMessage(pool, admin.id, { ...body, ticketId: match[1] })],
    ['POST', /^support\/([^/]+)\/status$/, ({ admin, body, match }) => support.setStatus(pool, admin.id, { ...body, ticketId: match[1] })],
    ['POST', /^support\/([^/]+)\/priority$/, ({ admin, body, match }) => support.setPriority(pool, admin.id, { ...body, ticketId: match[1] })],
    ['GET', /^support\/([^/]+)\/access$/, ({ match }) => supportAccess.ticketAccess(pool, match[1])],
    ['POST', /^support\/([^/]+)\/access\/connect$/, async ({ admin, match }) => {
      const link = await supportAccess.connect(pool, admin, { ticketId: match[1] });
      return { url: officeUrl(link), expiresInSeconds: 120 };
    }],
    ['POST', /^support\/([^/]+)\/access\/extend$/, ({ admin, match }) => supportAccess.extend(pool, admin.id, { ticketId: match[1] })],
    ['POST', /^support\/([^/]+)\/access\/request-extension$/, ({ admin, body, match }) =>
      supportAccess.requestExtension(pool, admin.id, { ticketId: match[1], minutes: body.minutes, note: body.note })],
    ['POST', /^support\/([^/]+)\/access\/end$/, ({ admin, match }) => supportAccess.endAccess(pool, admin.id, { ticketId: match[1] })],
    ['POST', /^support\/([^/]+)\/assign$/, ({ admin, body, match }) => support.assign(pool, admin.id, { ...body, ticketId: match[1] })],
  ];

  const callbackUrl = (req) => `${appOrigin || 'http://' + req.headers.host}/api/platform/pay/callback`;
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || undefined;
  const PAGE = {
    paid: 'Ödemeniz alındı. Teşekkür ederiz; aboneliğiniz güncellenecektir.',
    review: 'Ödemeniz alındı ve kontrol ediliyor. Sorun olursa sizinle iletişime geçeceğiz.',
    failed: 'Ödeme tamamlanamadı. Lütfen tekrar deneyin veya bizimle iletişime geçin.',
    initiated: 'Ödeme henüz tamamlanmadı.',
    superseded: 'Bu ödeme bağlantısı yenilendi. Lütfen güncel bağlantıyı kullanın.',
  };
  async function paymentCallback(req, res) {
    let token = '';
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 8 * 1024) throw fail(413, 'İstek çok büyük.');
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      token = String((String(req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw))).token || '');
    } catch {
      token = '';
    }
    let message;
    try {
      const result = await online.completePayment(pool, token, { iyzico });
      message = PAGE[result.status] || PAGE.failed;
    } catch (error) {
      if (!Number.isInteger(error.status) || error.status >= 500) console.error('Online payment callback failed');
      message = 'Ödeme sonucu alınamadı. Ödemeniz çekildiyse lütfen bizimle iletişime geçin.';
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ödeme sonucu</title></head><body><p>${message}</p></body></html>`);
  }

  return async function handle(req, res) {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/^\/api\/platform\/?/, '');
      if (!url.pathname.startsWith('/api/platform/') && url.pathname !== '/api/platform')
        throw fail(404, 'Bulunamadı.');
      if (!['GET', 'POST'].includes(req.method)) throw fail(405, 'İşlem desteklenmiyor.');
      // iyzico sends the customer's browser here after payment: a cross-site form POST with no
      // session. Nothing in it is trusted; the result is read back from iyzico by token.
      if (path === 'pay/callback' && req.method === 'POST') return await paymentCallback(req, res);
      if (!mutationSourceAllowed(req, security)) throw fail(403, 'İstek kaynağı doğrulanamadı.');

      if (path === 'session' && req.method === 'GET') {
        const admin = await auth.authenticate(pool, req).catch((error) => {
          if (error.status === 401) return null;
          throw error;
        });
        return send(200, { admin, ...(admin && !admin.totpEnabled && (await totpRequired()) ? { totpSetupRequired: true } : {}) });
      }
      if (path === 'login' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await auth.login(pool, {
          username: body.username,
          password: body.password,
          code: body.code,
          clientKey: attemptKey(req, secureCookies),
        });
        return send(
          200,
          { admin: result.admin },
          { 'Set-Cookie': auth.sessionCookie(result.token, { secure: secureCookies, maxAge: result.maxAge }) },
        );
      }
      if (path === 'logout' && req.method === 'POST') {
        await auth.logout(pool, req);
        return send(200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', { secure: secureCookies, maxAge: 0 }) });
      }

      const admin = await auth.authenticate(pool, req);
      if (!admin.totpEnabled && !/^account(\/|$)/.test(path) && (await totpRequired()))
        throw Object.assign(fail(403, 'Devam etmek için iki aşamalı doğrulamayı etkinleştirin.'), { totpSetupRequired: true });
      for (const [method, pattern, run] of routes) {
        const match = pattern.exec(path);
        if (!match || method !== req.method) continue;
        const body = method === 'POST' ? await readJson(req) : {};
        return send(200, await run({ admin, body, match, query: url.searchParams, req }));
      }
      throw fail(404, 'Bulunamadı.');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error('Platform request failed');
      return send(status, {
        error: status >= 500 ? 'Sunucu hatası.' : error.message,
        ...(error.totpRequired ? { totpRequired: true } : {}),
        ...(error.totpSetupRequired ? { totpSetupRequired: true } : {}),
      });
    }
  };
}

module.exports = { createPlatformHandler };

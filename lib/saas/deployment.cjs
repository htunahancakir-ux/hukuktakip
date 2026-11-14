const { createApplication } = require('../application.cjs');
const { createPlatformHandler } = require('../platform-app.cjs');
const { createOfficeSupport } = require('./office-support.cjs');
const { createSupportAccess } = require('./support-access.cjs');
const { createOfficeCatalog } = require('./office-catalog.cjs');
const { createUsageMeter } = require('./usage-meter.cjs');
const { createSeatGate } = require('./seat-gate.cjs');
const { createPlatformSms } = require('./platform-sms.cjs');
const { createPlatformMaps, createMapsMeter } = require('./platform-maps.cjs');
const platformBackup = require('./platform-backup.cjs');
const { createPool, createStore } = require('../postgres-store.cjs');
const { createTenantRouter } = require('./tenant-router.cjs');
const { createModuleGate } = require('./module-gate.cjs');
const { iyzicoFromEnv } = require('../iyzico.cjs');
// The platform's own iyzico merchant account (sales collected online). Unset or invalid keys
// only switch online payment off; they never stop the console.
function platformIyzico() {
  try {
    return iyzicoFromEnv();
  } catch {
    console.error('IYZICO configuration is invalid; online payment is disabled');
    return null;
  }
}
function createDeploymentHandler({
  pool = process.env.DATABASE_URL ? createPool() : null,
  cloud = true,
  background,
  baseDomain,
} = {}) {
  // Without HAN_TENANT_BASE_DOMAIN every request stays on the existing office.
  return createTenantRouter({
    pool,
    baseDomain,
    createHandler: ({ tenantId, slug, baseDomain }) =>
      createApplication({
        cloud,
        background,
        store: pool ? createStore(pool, { tenantId }) : undefined,
        // Paid add-ons (phone, AI) follow what the sales console recorded for this office.
        modules: pool ? createModuleGate(pool, { tenantId }) : undefined,
        officeSupport: pool ? createOfficeSupport(pool, { tenantId }) : undefined,
        // Time-limited entry of the support team, granted by the office on a support ticket.
        supportAccess: pool ? createSupportAccess(pool, { tenantId }) : undefined,
        // Announcements on the home page and the "Modüller" page (catalog, campaigns, requests).
        officeCatalog: pool ? createOfficeCatalog(pool, { tenantId }) : undefined,
        // AI tokens per office per day, priced in the console's profitability page.
        usageMeter: pool ? createUsageMeter(pool, { tenantId }) : undefined,
        // The purchased user count is enforced when accounts are created.
        seats: pool ? createSeatGate(pool, { tenantId }) : undefined,
        // The selling company's SMS account, for password recovery until the office sets up WhatsApp.
        platformSms: pool ? createPlatformSms(pool, { tenantId }) : undefined,
        // The selling company's map service, for offices subscribed to Rota Bulma as a service.
        platformMaps: pool ? createPlatformMaps(pool, { tenantId }) : undefined,
        // How many map searches the office made this month, shown on the Rota Bulma screen.
        mapsMeter: pool ? createMapsMeter(pool, { tenantId }) : undefined,
        // The nightly job also backs up every other office and the console, when the operator
        // switched that on (Yönetim → Yedekleme). It runs after the answer, within the
        // function's time limit.
        fleetBackup: pool
          ? () => platformBackup.runAll(pool, { scheduled: true, budgetMs: 70000 })
          : undefined,
        // Each office only accepts requests from its own origin.
        ...(slug ? { appOrigin: `https://${slug}.${baseDomain}` } : {}),
      }),
    // Operator console on admin.<base domain>: separate accounts, sessions and origin.
    createPlatformHandler: ({ baseDomain }) =>
      createPlatformHandler({
        pool,
        appOrigin: `https://admin.${baseDomain}`,
        secureCookies: true,
        iyzico: platformIyzico(),
        // Two-step sign-in becomes required once platform SMS is switched on; 1 / 0 force it.
        requireTotp: { 1: true, 0: false }[process.env.PLATFORM_REQUIRE_TOTP] ?? 'sms',
      }),
  });
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// A server of our own (outputs/icrapro/server.cjs behind a reverse proxy) has no hosting
// platform in front of it to serve the browser files or to call scheduled jobs on an office
// address. Browser files are the same for every address, so they are served by the existing
// office; scheduled jobs called on the loopback address run for the existing office.
function createStandaloneHandler(options = {}) {
  const route = createDeploymentHandler(options);
  const base = String(options.baseDomain ?? process.env.HAN_TENANT_BASE_DOMAIN ?? '')
    .trim()
    .toLowerCase();
  if (!base) return route;
  return (req, res) => {
    const host = String(req.headers.host || '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    let pathname = '/api/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {}
    if (!pathname.startsWith('/api/')) {
      if (host === 'admin.' + base && pathname === '/') req.url = '/platform.html';
      req.headers.host = base;
    } else if (LOOPBACK.has(host)) req.headers.host = base;
    return route(req, res);
  };
}

module.exports = { createDeploymentHandler, createStandaloneHandler };

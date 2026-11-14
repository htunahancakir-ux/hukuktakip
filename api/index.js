const { createApplication } = require('../lib/application.cjs');
const { createPlatformHandler } = require('../lib/platform-app.cjs');
const { createOfficeSupport } = require('../lib/saas/office-support.cjs');
const { createSupportAccess } = require('../lib/saas/support-access.cjs');
const { createOfficeCatalog } = require('../lib/saas/office-catalog.cjs');
const { createUsageMeter } = require('../lib/saas/usage-meter.cjs');
const { createSeatGate } = require('../lib/saas/seat-gate.cjs');
const { createPlatformSms } = require('../lib/saas/platform-sms.cjs');
const { createPlatformMaps, createMapsMeter } = require('../lib/saas/platform-maps.cjs');
const platformBackup = require('../lib/saas/platform-backup.cjs');
const { createPool, createStore } = require('../lib/postgres-store.cjs');
const { createTenantRouter } = require('../lib/saas/tenant-router.cjs');
const { createModuleGate } = require('../lib/saas/module-gate.cjs');
const { iyzicoFromEnv } = require('../lib/iyzico.cjs');
const { waitUntil } = require('@vercel/functions');
let router;
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
function build() {
  const pool = process.env.DATABASE_URL ? createPool() : null;
  // Without HAN_TENANT_BASE_DOMAIN every request stays on the existing office.
  return createTenantRouter({
    pool,
    createHandler: ({ tenantId, slug, baseDomain }) =>
      createApplication({
        cloud: true,
        background: waitUntil,
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
        fleetBackup: pool ? () => platformBackup.runAll(pool, { scheduled: true, budgetMs: 70000 }) : undefined,
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
module.exports = async function (req, res) {
  router ||= build();
  req.url = require('../lib/api-request-url.cjs').apiRequestUrl(req);
  return router(req, res);
};

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createAccess } = require('../outputs/icrapro/access-server.cjs');
const { createBackupService } = require('./backup-service.cjs');
const { createLocalBackupStore } = require('./local-backup-store.cjs');
const { event: auditEvent, requestEvents, auditQuery, createLocalAuditStore } = require('./audit.cjs');
const { sessionCookie } = require('./session-policy.cjs');
const { deliverWhatsApp } = require('./whatsapp.cjs');
const { renderWhatsAppMedia } = require('./whatsapp-media.cjs');
const { REQUIRED_MESSAGE } = require('./employee-terms.cjs');
const { deliverScheduledReminders, schedulerAuthorized } = require('./scheduled-reminders.cjs');
const workspaceScripts = require('../outputs/icrapro/workspace-assets.js');
const { executeAccess, bufferedResponse, MAX_BODY, ATTACHMENT_BODY } = require('./access-executor.cjs');
const { mutationSourceAllowed, secureCookiesRequired } = require('./request-security.cjs');
const { readOnlyDenied, MESSAGE: READ_ONLY_MESSAGE } = require('./read-only-account.cjs');
const { GATED_MODULES } = require('./saas/module-gate.cjs');

// Requests that can add or reactivate an account, so only they pay for a limit lookup.
const USER_CREATING_PATHS = new Set(['/api/users', '/api/personnel-save']);

const MODULE_MESSAGES = {
  voip: 'Telefon (VoIP) modülü bu büroda etkin değil.',
  'ai-assistant': 'Yapay zekâ modülü bu büroda etkin değil.',
  whatsapp: 'WhatsApp modülü bu büroda etkin değil.',
  'marketing-routes': 'Pazarlama ve rota modülü bu büroda etkin değil.',
};
// Which paid add-on a request belongs to, if any.
function moduleForPath(pathname) {
  if (pathname.startsWith('/api/voip/')) return 'voip';
  if (pathname.startsWith('/api/ai/') || pathname === '/api/documents/conversation-report')
    return 'ai-assistant';
  if (pathname.startsWith('/api/whatsapp/')) return 'whatsapp';
  if (pathname.startsWith('/api/marketing/')) return 'marketing-routes';
  return null;
}
const files = new Set([
  'index.html',
  'style.css',
  'workspace-layout.css',
  'voip.css',
  'workspace-assets.js',
  'html-safety.js',
  'record-patch.js',
  'login-recovery.js',
  'login-layout.js',
  'login-layout.css',
  'login-justice-v1.png',
  'brand-scales.png',
  'employee-terms.js',
  'employee-terms-settings.js',
  'modal-dismissal.js',
  'auth.js',
  'platform.html',
  'platform.css',
  'platform.js',
  // Page screenshots for Geri bildirim (MIT, vendored: scripts are served only from this site).
  'html2canvas.min.js',
  ...workspaceScripts,
]);

async function readBody(req, maxBytes = MAX_BODY) {
  let buffer;
  if (req.body !== undefined)
    buffer = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  else {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk);
      if (length > maxBytes) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  }
  if (buffer.length > maxBytes) throw Object.assign(new Error('Body too large'), { status: 413 });
  return buffer;
}

function createApplication({
  store,
  cloud = false,
  appOrigin = process.env.APP_ORIGIN,
  backupR2Client,
  whatsappFetch,
  voipFetch,
  mapsFetch,
  iyzicoFetch,
  // Optional add-on gate ({ enabled(code), all() }). Without one every feature is on.
  modules,
  // Optional purchased-user-count gate ({ limit() }); accounts beyond it are refused.
  seats,
  // Optional platform SMS sender ({ available(), send() }) for password recovery.
  platformSms,
  // Optional office-side support desk (lib/saas/office-support.cjs). Without one /api/support is absent.
  officeSupport,
  // Optional AI usage meter (lib/saas/usage-meter.cjs) for the platform's cost per office.
  usageMeter,
  // Optional remote support access (lib/saas/support-access.cjs): time-limited entry of the
  // platform's support team through the office's hidden support account.
  supportAccess,
  // Optional office-side catalog (lib/saas/office-catalog.cjs): home-page announcements and the
  // "Modüller" page. Without one /api/platform-news and /api/office-modules are absent.
  officeCatalog,
  // fetch used for Verimor SMS (tests replace it)
  smsFetch,
  background = (promise) => {
    void promise;
  },
} = {}) {
  const secureCookies = secureCookiesRequired({ secureCookies: cloud, appOrigin });
  const requestSecurity = { appOrigin, secureCookies };
  const stateFile = process.env.HANHUKUK_STATE_FILE || path.resolve(__dirname, '../work/hanhukuk-state.json');
  const localReminderScheduler = !cloud && !store && process.env.HANHUKUK_LOCAL_REMINDER_DELIVERY === '1';
  const local =
    !cloud && !store
      ? createAccess(stateFile, {
          audit: true,
          localReminderScheduler,
          mapsFetch,
          iyzicoFetch,
          smsFetch,
          allowLocalServices: true,
          ...requestSecurity,
        })
      : null;
  const audit = store || createLocalAuditStore(stateFile);
  let voipQueue = Promise.resolve();
  const handleVoip = require('./voip.cjs').createVoipHandler({
    transaction: (work, scope) => {
      if (store) return store.voipTransaction(work, scope);
      const result = voipQueue.then(() => local.metadataTransaction(work));
      voipQueue = result.catch(() => {});
      return result;
    },
    authenticatedUser,
    readBody,
    fetcher: voipFetch,
    localTranscription: !!local,
    background,
    onCallDeleted: (user, call) =>
      audit.appendAudit([
        auditEvent(
          user,
          'changes',
          'delete',
          'Görüşme Kayıtları',
          [call.documentNumber, call.debtorName, call.phone, call.createdAt].filter(Boolean).join(' · '),
        ),
      ]),
    recordings: require('./voip-recordings.cjs').createRecordingStore({
      cloud,
      directory: path.join(path.dirname(stateFile), 'voip'),
    }),
  });
  const backups = createBackupService({
    store: store || createLocalBackupStore(stateFile),
    localDirectory: local ? path.join(path.dirname(stateFile), 'backups') : null,
    cloud,
    r2Client: backupR2Client,
  });
  let nextMaintenance = 0;
  // Scheduled backups at chosen times: besides the once-a-day cloud trigger, the policy is checked
  // at most every 5 minutes while people use the app (notification polling).
  let nextBackupCheck = 0;
  function scheduleBackupCheck() {
    if (Date.now() < nextBackupCheck) return;
    nextBackupCheck = Date.now() + 300000;
    background(backups.run().catch(() => console.error('Scheduled backup check failed')));
  }
  function scheduleMaintenance() {
    scheduleBackupCheck();
    if (!store?.maintenance || Date.now() < nextMaintenance) return;
    nextMaintenance = Date.now() + 60000;
    background(
      store
        .maintenance(async (tx) => {
          const access = createAccess(null, {
            initialState: tx.state,
            saveState: tx.saveState,
            timers: false,
            skipPayroll: tx.skipPayroll,
            workflowRanking: tx.workflowRanking,
          });
          if (access.runMaintenance())
            await tx.appendAudit([auditEvent(null, 'changes', 'update', 'Zamanlanmış iş akışı')]);
        })
        .catch(() => {
          console.error('Workspace maintenance failed');
        }),
    );
  }

  // AI usage of a committed request, for the platform's usage cost. Runs after the database
  // transaction, so a retried transaction is counted once.
  async function finalizeUsage(response) {
    const used = response.hanAiUsage;
    delete response.hanAiUsage;
    if (!used?.length || !usageMeter || response.statusCode < 200 || response.statusCode >= 300) return;
    for (const usage of used) await usageMeter.recordAi(usage);
  }

  // A support access grant is recorded in the control plane once the office's transaction (which
  // prepared the support account) has committed. If that fails the office sees the error; the
  // account alone opens nothing, since only a grant can create its sessions.
  async function finalizeSupportGrant(response) {
    const grant = response.hanSupportGrant;
    delete response.hanSupportGrant;
    if (!grant || !supportAccess || response.statusCode < 200 || response.statusCode >= 300) return;
    try {
      const saved = await supportAccess.grant(grant.user, grant);
      response.body = JSON.stringify({
        ok: true,
        accessId: saved.id,
        minutes: saved.minutes,
        allowEdit: saved.allowEdit,
      });
      delete response.headers['content-length'];
    } catch (error) {
      response.statusCode = error.status || 500;
      response.body = JSON.stringify({ error: error.status ? error.message : 'Erişim izni kaydedilemedi.' });
    }
  }

  // SMS (a recovery code or a test message) is sent only after the request committed, so a
  // retried transaction never sends twice. The office's own SMS account (job.config) is used when
  // it is set up; otherwise the platform's SMS service sends recovery codes.
  async function finalizeSms(response) {
    const job = response.hanSms;
    delete response.hanSms;
    if (!job || response.statusCode < 200 || response.statusCode >= 300) return;
    if (!job.config) {
      if (!platformSms) return;
      const platformDelivery = platformSms
        .send({ to: job.to, text: job.text, purpose: 'password_recovery' })
        .catch(() => console.error('Recovery SMS failed'));
      if (job.silent) background(platformDelivery);
      else await platformDelivery;
      return;
    }
    const delivery = (async () =>
      require('./sms-settings.cjs')
        .clientFor(job.config, {}, { fetcher: smsFetch })
        .send({ to: job.to, text: job.text }))();
    if (job.silent) {
      background(delivery.catch(() => console.error('SMS delivery failed')));
      return;
    }
    try {
      await delivery;
      response.body = JSON.stringify({ ...JSON.parse(response.body), sms: { sent: true } });
    } catch (error) {
      response.body = JSON.stringify({
        ...JSON.parse(response.body),
        sms: { sent: false, error: error.status ? error.message : 'SMS gönderilemedi.' },
      });
    }
  }

  // Records that asked for WhatsApp keep each recipient's result (accepted, or failed with Meta's code).
  async function saveWhatsAppOutcomes(record, outcomes) {
    if (record?.collection !== 'messages' || !outcomes?.length) return;
    const work = ({ state, saveState }) => {
      const message = (state.messages || []).find((row) => row.id === record.id);
      if (!message?.whatsapp) return;
      const at = new Date().toISOString();
      for (const { recipientId, status, reason, error } of outcomes)
        if (message.whatsapp[recipientId])
          message.whatsapp[recipientId] = {
            status,
            ...(reason && { reason }),
            ...(error && { error: (error.code ? 'Hata ' + error.code + ': ' : '') + error.message }),
            at,
          };
      saveState(state);
    };
    try {
      if (store?.deliveryTransaction) await store.deliveryTransaction(work, { messageIds: [record.id] });
      else if (store) await store.transaction(work);
      else if (local) await local.metadataTransaction(work);
    } catch {
      console.error('WhatsApp delivery status write failed');
    }
  }

  async function finalizeWhatsApp(response) {
    const batch = response.hanWhatsApp;
    if (!batch || response.statusCode < 200 || response.statusCode >= 300) return;
    // Sending is part of the WhatsApp add-on. Account recovery links stay deliverable: the
    // office cannot configure WhatsApp without the module, so this only matters for offices
    // that already had it set up.
    if (modules && batch.template !== 'resetTemplate' && !(await modules.enabled('whatsapp'))) {
      delete response.hanWhatsApp;
      await saveWhatsAppOutcomes(
        batch.record,
        batch.jobs.flatMap((job) =>
          (job.recipientIds || []).map((recipientId) => ({ recipientId, status: 'skipped', reason: 'off' })),
        ),
      );
      return;
    }
    const delivery = deliverWhatsApp(batch, { fetcher: whatsappFetch, renderMedia: renderWhatsAppMedia });
    if (batch.silent) {
      background(
        delivery.then((result) => saveWhatsAppOutcomes(batch.record, result.outcomes)).catch(() => {}),
      );
      return;
    }
    const { outcomes, ...result } = await delivery;
    await saveWhatsAppOutcomes(batch.record, outcomes);
    if (result.accepted && response.hanAudit?.actor) {
      try {
        await audit.appendAudit([
          auditEvent(response.hanAudit.actor, 'changes', 'whatsapp', 'WhatsApp Business'),
        ]);
      } catch {
        console.error('WhatsApp audit write failed');
      }
    }
    response.body = JSON.stringify({ ...JSON.parse(response.body), whatsapp: result });
  }


  async function authenticatedUser(req, { allowPendingTerms = false } = {}) {
    const replay = {
      method: 'GET',
      headers: req.headers,
      socket: req.socket,
      async *[Symbol.asyncIterator]() {},
    };
    const url = new URL('/api/session', 'http://localhost');
    const response = bufferedResponse();
    if (local) await local(replay, response, url);
    else {
      if (!store || (cloud && !appOrigin))
        throw Object.assign(new Error('Server configuration incomplete'), { status: 503 });
      const context = await store.security.readIdentity(req);
      Object.assign(response, await executeAccess(context, replay, url, null, { readOnly: true }));
    }
    const { user, employeeTermsRequired } = JSON.parse(response.body || '{}');
    if (!user) throw Object.assign(new Error('Oturum açmanız gerekiyor.'), { status: 401 });
    if (employeeTermsRequired && !allowPendingTerms)
      throw Object.assign(new Error(REQUIRED_MESSAGE), { status: 428 });
    return user;
  }

  async function managerUser(req) {
    let user;
    try {
      user = await authenticatedUser(req);
    } catch (error) {
      if (error.status === 401)
        throw Object.assign(new Error('Bu bölüm için yönetici girişi gerekli.'), { status: 403 });
      throw error;
    }
    if (!['ceo', 'admin'].includes(user.role))
      throw Object.assign(new Error('Bu bölüm için yönetici girişi gerekli.'), { status: 403 });
    if (user.role !== 'ceo' && user.readOnly && !['GET', 'HEAD'].includes(req.method))
      throw Object.assign(new Error(READ_ONLY_MESSAGE), { status: 403 });
    return user;
  }

  async function handleBackupIndicator(req, res) {
    const send = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method !== 'GET') return send(405, { error: 'İşlem desteklenmiyor.' });
      await authenticatedUser(req);
      const status = await backups.status();
      const nextDue = Date.parse(status.nextDueAt || '');
      const protectedBackup =
        status.enabled &&
        !!status.lastSuccessAt &&
        !!status.lastR2At &&
        !status.lastError &&
        status.r2Configured &&
        status.encryptionConfigured &&
        status.scheduleConfigured &&
        Number.isFinite(nextDue) &&
        Date.now() <= nextDue + 12 * 60 * 60 * 1000;
      return send(200, { lastSuccessAt: status.lastSuccessAt, protected: protectedBackup });
    } catch (error) {
      if (error.status === 428) return send(428, { error: error.message, code: 'employee_terms_required' });
      return send(error.status || 503, {
        error: error.message && error.status ? error.message : 'Yedekleme durumu doğrulanamadı.',
      });
    }
  }

  async function handleBackup(req, res, url) {
    const send = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === '/api/backups/cron') {
        const expected = process.env.CRON_SECRET || '';
        const received = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const a = Buffer.from(expected),
          b = Buffer.from(received);
        if (
          req.method !== 'GET' ||
          !expected ||
          a.length !== b.length ||
          !require('node:crypto').timingSafeEqual(a, b)
        )
          return send(401, { error: 'Yetkisiz istek.' });
        return send(200, await backups.run());
      }
      if (!['GET', 'PUT', 'POST'].includes(req.method)) return send(405, { error: 'İşlem desteklenmiyor.' });
      if (!mutationSourceAllowed(req, requestSecurity))
        return send(403, { error: 'İstek kaynağı doğrulanamadı.' });
      const user = await managerUser(req);
      if (url.pathname === '/api/backups' && req.method === 'GET') return send(200, await backups.status());
      if (url.pathname === '/api/backups/files' && req.method === 'GET')
        return send(200, await backups.list(url.searchParams.get('month')));
      if (url.pathname === '/api/backups/download' && req.method === 'GET') {
        await backups.download(url.searchParams.get('key'), user, async (body, filename) => {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'private, no-store',
          });
          // Save the download record before ending the response.
          await pipeline(body, res, { end: false });
          if (res.destroyed) throw new Error('Download connection closed');
          await audit.appendAudit([auditEvent(user, 'changes', 'download', 'Yedekleme', filename)]);
        });
        return res.end();
      }
      if (url.pathname === '/api/backups' && req.method === 'PUT') {
        const result = await backups.configure(JSON.parse((await readBody(req)).toString() || '{}'));
        await audit.appendAudit([
          auditEvent(user, 'changes', 'update', 'Yedekleme', null, ['Otomatik yedekleme ayarları']),
        ]);
        return send(200, result);
      }
      if (url.pathname === '/api/backups/run' && req.method === 'POST') {
        const result = await backups.run({ force: true });
        if (result.ok) await audit.appendAudit([auditEvent(user, 'changes', 'backup', 'Yedekleme')]);
        return send(200, result);
      }
      return send(404, { error: 'İşlem bulunamadı.' });
    } catch (error) {
      if (error.status === 428) return send(428, { error: error.message, code: 'employee_terms_required' });
      console.error('Backup request failed', {
        status: error.status || 503,
        name: error.cause?.name || error.name,
      });
      if (res.headersSent || res.destroyed) return res.destroy();
      return send(error.status || 503, {
        error: error.message && error.status ? error.message : 'Yedekleme işlemi tamamlanamadı.',
      });
    }
  }

  if (local) {
    const timer = setInterval(
      () =>
        backups
          .run()
          .catch((error) =>
            console.error('Scheduled backup failed', { name: error.cause?.name || error.name }),
          ),
      15 * 60000,
    );
    timer.unref();
  }
  if (localReminderScheduler) {
    const timer = setInterval(() => {
      deliverScheduledReminders(local.metadataTransaction, {
        authorize: () => true,
        fetcher: whatsappFetch,
      }).catch(() => console.error('Scheduled reminders failed'));
    }, 30000);
    timer.unref();
  }
  return async (req, res) => {
    require('./chunked-json.cjs').chunkedJson(req, res);
    const requestStarted = performance.now();
    if (process.env.HAN_METRICS === '1')
      res.once('finish', () =>
        console.log(
          JSON.stringify({
            metric: 'http_request',
            method: req.method,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - requestStarted),
            responseBytes: res.hanResponseBytes ?? null,
          }),
        ),
      );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const required = modules ? moduleForPath(url.pathname) : null;
        if (required && !(await modules.enabled(required)))
          throw Object.assign(new Error(MODULE_MESSAGES[required]), { status: 403, module: required });
        if (
          [
            '/api/voip/webhook',
            '/api/voip/route',
            '/api/voip/watchdog',
            '/api/voip/cron',
            '/api/voip/transcription-cron',
          ].includes(url.pathname)
        )
          return await handleVoip(req, res, url);
        if (url.pathname === '/api/scheduled-reminders/cron') {
          const secret = String(req.headers.authorization || '').replace(/^Bearer /, '');
          const reminderModuleOff = modules && !(await modules.enabled('whatsapp'));
          const result =
            req.method === 'POST' && store && /^[a-f0-9]{64}$/.test(secret) && reminderModuleOff
              ? { skipped: 'module' }
              : req.method === 'POST' && store && /^[a-f0-9]{64}$/.test(secret)
                ? await deliverScheduledReminders(store.reminderTransaction || store.transaction, {
                    authorize: (state) => schedulerAuthorized(state, secret),
                    fetcher: whatsappFetch,
                  })
                : null;
          res.writeHead(result ? 200 : 401, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result || { error: 'Yetkisiz istek.' }));
        }
        // Cron endpoints authenticate with their own secret, never a browser cookie.
        if (url.pathname === '/api/backups/cron') return handleBackup(req, res, url);
        if (!mutationSourceAllowed(req, requestSecurity))
          throw Object.assign(new Error('İstek kaynağı doğrulanamadı.'), { status: 403 });
        if (url.pathname.startsWith('/api/voip/')) return await handleVoip(req, res, url);
        if (officeSupport && (url.pathname === '/api/support' || url.pathname.startsWith('/api/support/'))) {
          // Any signed-in user may open a ticket; CEO and admins see all of the office's tickets,
          // others their own. Read-only accounts and the support team's own account only read.
          const user = await authenticatedUser(req);
          if (req.method !== 'GET' && (user.platformSupport || (user.role !== 'ceo' && user.readOnly)))
            throw Object.assign(new Error(READ_ONLY_MESSAGE), { status: 403 });
          const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(data));
          };
          const input = async () => {
            try {
              const parsed = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
              return parsed;
            } catch (error) {
              if (error.status) throw error;
              throw Object.assign(new Error('Geçersiz istek.'), { status: 400 });
            }
          };
          const route = url.pathname.slice('/api/support'.length).replace(/^\//, '');
          if (route === '' && req.method === 'GET') return send(200, await officeSupport.list(user));
          if (route === '' && req.method === 'POST')
            return send(200, await officeSupport.open(user, await input()));
          const reply = /^([^/]+)\/messages$/.exec(route);
          if (reply && req.method === 'POST')
            return send(200, await officeSupport.reply(user, reply[1], await input()));
          const resolved = /^([^/]+)\/resolved$/.exec(route);
          if (resolved && req.method === 'POST')
            return send(200, await officeSupport.confirmResolved(user, resolved[1]));
          if (/^[^/]+$/.test(route) && req.method === 'GET')
            return send(200, await officeSupport.detail(route, user));
          throw Object.assign(new Error('İşlem desteklenmiyor.'), { status: 405 });
        }
        if (supportAccess && url.pathname === '/api/support-access/enter' && req.method === 'GET') {
          // The support team's entry link, opened from the platform console. No session needed:
          // the one-time code is the credential. It becomes a session for the support account
          // that ends at the grant's deadline.
          let entered;
          try {
            entered = await supportAccess.enter(url.searchParams.get('code'));
          } catch (error) {
            res.writeHead(error.status || 500, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            return res.end(
              '<!doctype html><meta charset="utf-8"><title>Destek bağlantısı</title><p>' +
                String(error.status ? error.message : 'Destek bağlantısı açılamadı.').replace(/[<>&]/g, '') +
                '</p>',
            );
          }
          await audit.appendAudit([
            auditEvent(
              { id: 'platform-support', name: 'Hukuk Takip Platformu Destek', username: 'hukuktakip-destek' },
              'login',
              'login',
              'Destek erişimi',
            ),
          ]);
          res.writeHead(302, {
            Location: '/',
            'Cache-Control': 'no-store',
            'Set-Cookie': sessionCookie(entered.token, {
              secure: secureCookies,
              maxAge: entered.maxAgeSeconds,
            }),
          });
          return res.end();
        }
        if (
          supportAccess &&
          url.pathname.startsWith('/api/support-access/') &&
          url.pathname !== '/api/support-access/grant'
        ) {
          const user = await authenticatedUser(req);
          const send = (status, data) => {
            res.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            return res.end(JSON.stringify(data));
          };
          if (url.pathname === '/api/support-access/status' && req.method === 'GET')
            return send(200, await supportAccess.status(user));
          const action = /^\/api\/support-access\/([^/]+)\/(extension|end)$/.exec(url.pathname);
          if (action && req.method === 'POST') {
            if (user.role !== 'ceo' && user.readOnly)
              throw Object.assign(new Error(READ_ONLY_MESSAGE), { status: 403 });
            if (action[2] === 'end') return send(200, await supportAccess.end(user, action[1]));
            let input = {};
            try {
              input = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8') || '{}') || {};
            } catch {
              throw Object.assign(new Error('Geçersiz istek.'), { status: 400 });
            }
            return send(200, await supportAccess.decideExtension(user, action[1], input.approve === true));
          }
          throw Object.assign(new Error('İşlem desteklenmiyor.'), { status: 405 });
        }
        if (
          officeCatalog &&
          (url.pathname === '/api/platform-news' || url.pathname.startsWith('/api/platform-news/'))
        ) {
          // Every signed-in user may see a card (sales cards are filtered to managers inside).
          // Marking a card seen or closed is allowed to read-only accounts: it changes no office data.
          const user = await authenticatedUser(req);
          const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(data));
          };
          if (url.pathname === '/api/platform-news' && req.method === 'GET')
            return send(200, await officeCatalog.news(user));
          const action = /^\/api\/platform-news\/([^/]+)\/(click|dismiss|interest)$/.exec(url.pathname);
          if (action && req.method === 'POST') {
            if (action[2] === 'interest' && user.role !== 'ceo' && user.readOnly)
              throw Object.assign(new Error(READ_ONLY_MESSAGE), { status: 403 });
            return send(200, await officeCatalog.mark(user, action[1], action[2]));
          }
          throw Object.assign(new Error('İşlem desteklenmiyor.'), { status: 405 });
        }
        if (
          officeCatalog &&
          (url.pathname === '/api/office-modules' || url.pathname.startsWith('/api/office-modules/'))
        ) {
          // Managers only; a read-only manager can look but not request (managerUser enforces it).
          const user = await managerUser(req);
          const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(data));
          };
          if (url.pathname === '/api/office-modules' && req.method === 'GET')
            return send(200, await officeCatalog.catalog());
          if (url.pathname === '/api/office-modules/request' && req.method === 'POST') {
            let input;
            try {
              input = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
              if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('shape');
            } catch (error) {
              if (error.status) throw error;
              throw Object.assign(new Error('Geçersiz istek.'), { status: 400 });
            }
            return send(200, await officeCatalog.requestProduct(user, input));
          }
          throw Object.assign(new Error('İşlem desteklenmiyor.'), { status: 405 });
        }
        if (url.pathname === '/api/modules' && req.method === 'GET') {
          await authenticatedUser(req);
          const flags = modules
            ? await modules.all()
            : Object.fromEntries(GATED_MODULES.map((code) => [code, true]));
          // Not an add-on: tells the screen the support desk exists on this installation.
          if (officeSupport) flags.supportDesk = true;
          // Not an add-on: the "Modüller" page and home-page announcements exist here.
          if (officeCatalog) flags.catalog = true;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(flags));
        }
        if (url.pathname === '/api/documents/lease') {
          if (req.method !== 'POST') throw Object.assign(Error('İşlem desteklenmiyor.'), { status: 405 });
          if (!store?.recordQueries?.documentLease)
            throw Object.assign(Error('Föy kilit sistemi hazır değil.'), { status: 503 });
          const result = await store.recordQueries.documentLease(req, JSON.parse(await readBody(req)));
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return res.end(JSON.stringify(result));
        }
        if (
          !['GET', 'HEAD'].includes(req.method) &&
          ![
            '/api/login',
            '/api/setup',
            '/api/logout',
            '/api/presence',
            '/api/password-reset/request',
            '/api/password-reset/complete',
            '/api/password-reset/sms-complete',
            '/api/employee-terms/accept',
            '/api/employee-terms/reminder-seen',
          ].includes(url.pathname)
        ) {
          const user = await authenticatedUser(req, { allowPendingTerms: true });
          if (readOnlyDenied(user, req.method, url.pathname))
            throw Object.assign(new Error(READ_ONLY_MESSAGE), { status: 403 });
        }
        if (
          req.method === 'GET' &&
          store?.recordQueries?.activity &&
          [
            '/api/messages',
            '/api/messages/summary',
            '/api/work-orders',
            '/api/scheduled-reminders',
            '/api/notifications',
          ].includes(url.pathname)
        ) {
          const result = await store.recordQueries.activity(req, url);
          await store.security.touch(req);
          if (url.pathname === '/api/notifications') scheduleMaintenance();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result));
        }
        if (url.pathname === '/api/backups' || url.pathname.startsWith('/api/backups/'))
          return handleBackup(req, res, url);
        if (url.pathname === '/api/backup-indicator') return handleBackupIndicator(req, res);
        if (url.pathname === '/api/records/reports/export') {
          if (req.method !== 'GET') throw Object.assign(Error('Yöntem desteklenmiyor.'), { status: 405 });
          if (!store?.recordQueries) throw Object.assign(Error('Kayıt deposu etkin değil.'), { status: 503 });
          const output = await store.recordQueries.reportExport(req, Object.fromEntries(url.searchParams));
          // Vercel enforces a response size limit even for generated downloads.
          // Validate the whole file before sending headers; never hand out a
          // silently truncated CSV/printout. Memory is bounded by this ceiling.
          let cloudOutput;
          if (cloud) {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of output.chunks) {
              const buffer = Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > 4 * 1024 * 1024)
                throw Object.assign(
                  Error(
                    'Rapor çıktısı çok büyük. Tarih, müvekkil veya personel filtresiyle seçimi daraltıp yeniden indirin.',
                  ),
                  { status: 400 },
                );
              chunks.push(buffer);
            }
            cloudOutput = Buffer.concat(chunks);
          }
          res.writeHead(200, {
            'Content-Type': output.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8',
            'Content-Disposition':
              (output.format === 'csv' ? 'attachment' : 'inline') + '; filename="' + output.filename + '"',
            'Cache-Control': 'private, no-store',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
          });
          if (cloudOutput) return res.end(cloudOutput);
          return await pipeline(require('node:stream').Readable.from(output.chunks), res);
        }
        if (
          [
            '/api/records/documents',
            '/api/records/client-payouts',
            '/api/records/client-payout',
            '/api/records/accounting',
            '/api/records/personnel-attachments',
            '/api/records/personnel-ledger',
            '/api/records/reports',
            '/api/records/reports/ins',
            '/api/records/document',
            '/api/records/clients',
            '/api/records/client',
            '/api/records/intake-batch',
            '/api/records/related',
            '/api/records/dashboard',
            '/api/records/bootstrap',
            '/api/records/search',
          ].includes(url.pathname) ||
          (url.pathname === '/api/search' && store?.recordQueries)
        ) {
          if (req.method !== 'GET') throw Object.assign(Error('Yöntem desteklenmiyor.'), { status: 405 });
          if (!store?.recordQueries)
            throw Object.assign(Error('Kayıt bazlı erişim henüz etkin değil.'), { status: 503 });
          const input = Object.fromEntries(url.searchParams);
          const result =
            url.pathname === '/api/records/personnel-ledger'
              ? await store.recordQueries.personnelLedger(req, input)
              : url.pathname === '/api/records/personnel-attachments'
                ? await store.recordQueries.personnelAttachments(req, input)
                : url.pathname === '/api/records/client-payouts'
                  ? await store.recordQueries.payouts(req, input)
                  : url.pathname === '/api/records/client-payout'
                    ? await store.recordQueries.payout(req, input.id)
                    : url.pathname === '/api/records/accounting'
                      ? await store.recordQueries.accounting(req, input)
                      : url.pathname === '/api/records/reports'
                        ? await store.recordQueries.reports(req, input)
                        : url.pathname === '/api/records/reports/ins'
                          ? await store.recordQueries.insReport(req, input)
                          : url.pathname === '/api/records/intake-batch'
                            ? await store.recordQueries.intakeBatch(req, input)
                            : url.pathname === '/api/records/related'
                              ? await store.recordQueries.related(req, input)
                              : ['/api/search', '/api/records/search'].includes(url.pathname)
                                ? await store.recordQueries.search(req, input)
                                : url.pathname === '/api/records/bootstrap'
                                  ? await store.recordQueries.bootstrap(req)
                                  : url.pathname === '/api/records/dashboard'
                                    ? await store.recordQueries.dashboard(req, input)
                                    : url.pathname === '/api/records/documents'
                                      ? await store.recordQueries.documents(req, input)
                                      : url.pathname === '/api/records/clients'
                                        ? await store.recordQueries.clients(req, input)
                                        : url.pathname === '/api/records/client'
                                          ? await store.recordQueries.client(req, input.id, input)
                                          : await store.recordQueries.detail(req, input.id, input);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result));
        }
        if (url.pathname === '/api/personnel-ledger/cron') {
          const expected = Buffer.from(process.env.CRON_SECRET || ''),
            received = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
          if (
            req.method !== 'GET' ||
            !expected.length ||
            expected.length !== received.length ||
            !require('node:crypto').timingSafeEqual(expected, received)
          )
            throw Object.assign(Error('Yetkisiz istek.'), { status: 401 });
          if (!store?.recordQueries?.refreshPersonnelLedger)
            throw Object.assign(Error('Personel cari kayıt deposu hazır değil.'), { status: 503 });
          const result = await store.recordQueries.refreshPersonnelLedger();
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return res.end(JSON.stringify(result));
        }
        if (url.pathname === '/api/audit') {
          if (req.method !== 'GET') throw Object.assign(new Error('İşlem desteklenmiyor.'), { status: 405 });
          await managerUser(req);
          const entries = await audit.listAudit(auditQuery(url.searchParams));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(entries));
        }
        if (local && req.method === 'GET') return await local(req, res, url);
        if (!local && (!store || (cloud && !appOrigin)))
          throw Object.assign(new Error('Server configuration incomplete'), { status: 503 });
        // Map service calls (Google Places, the tarama sunucusu) take seconds and never
        // write state: run them without holding the serializable business
        // transaction, but count them per IP.
        const mapRead =
          req.method === 'POST' &&
          [
            '/api/marketing/search',
            '/api/marketing/scrape',
            '/api/marketing/scrape-status',
            '/api/marketing/route-places',
            '/api/marketing/test',
          ].includes(url.pathname);
        if (
          !local &&
          (req.method === 'GET' || mapRead || (url.pathname === '/api/presence' && req.method === 'POST'))
        ) {
          const rateChecked = mapRead && (await store.security.consumeAttempt(req, url.pathname, cloud));
          const mapBody = mapRead ? await readBody(req, 64 * 1024) : null;
          const identityOnly = ['/api/presence', '/api/notifications'].includes(url.pathname);
          const context = identityOnly
            ? await store.security.readIdentity(req, {
                presence: url.pathname === '/api/presence',
                activity: url.pathname === '/api/notifications',
              })
            : await store.readSessionContext(req, url).catch((error) => {
                if (url.pathname === '/api/session' && error.status === 401)
                  return store.security.readIdentity(req);
                throw error;
              });
          const response = await executeAccess(context, req, url, mapBody, {
            readOnly: true,
            recordStore: !!store.recordQueries,
            secureCookies,
            appOrigin,
            mapsFetch,
            iyzicoFetch,
            allowLocalServices: !cloud,
            rateChecked,
          });
          if (response.statusCode === 200 && context.sessions.size) {
            await store.security.touch(req);
            if (url.pathname === '/api/notifications') scheduleMaintenance();
          }
          res.hanResponseBytes = response.bytes;
          res.setHeader('Server-Timing', 'app;dur=' + (performance.now() - requestStarted).toFixed(1));
          res.writeHead(response.statusCode, response.headers);
          return res.end(response.body);
        }
        const raw = await readBody(
          req,
          local ? 25 * 1024 * 1024 : url.pathname === '/api/record-attachments' ? ATTACHMENT_BODY : MAX_BODY,
        );
        const replay = {
          method: req.method,
          headers: req.headers,
          socket: req.socket,
          async *[Symbol.asyncIterator]() {
            if (raw.length) yield raw;
          },
        };
        if (local) {
          const buffered = bufferedResponse();
          await local(replay, buffered, url);
          try {
            await audit.appendAudit(requestEvents(req, url, raw, buffered));
          } catch (error) {
            console.error('Local audit write failed', { name: error.name });
          }
          await finalizeWhatsApp(buffered);
          await finalizeSms(buffered);
          await finalizeUsage(buffered);
          res.writeHead(buffered.statusCode, buffered.headers);
          return res.end(buffered.body);
        }
        const smsAvailable =
          platformSms && url.pathname === '/api/password-reset/request'
            ? await platformSms.available()
            : false;
        const userLimit =
          seats && req.method === 'POST' && USER_CREATING_PATHS.has(url.pathname)
            ? await seats.limit()
            : undefined;
        const identityMutation =
          ['/api/login', '/api/logout'].includes(url.pathname) && req.method === 'POST';
        const rateChecked = await store.security.consumeAttempt(req, url.pathname, cloud);
        const execute = async (tx) => {
          const response = await executeAccess(tx, req, url, raw, {
            secureCookies,
            appOrigin,
            rateChecked,
            smsFetch,
            recordStore: !!store.recordQueries,
            mapsFetch,
            iyzicoFetch,
            allowLocalServices: !cloud,
            ...(userLimit === undefined ? {} : { userLimit }),
            smsAvailable,
            supportAccess: !!supportAccess,
          });
          // A failed business command must not commit any earlier mutation.
          // Failed logins deliberately commit rate counters and their audit entry.
          if (!identityMutation && response.statusCode >= 400)
            throw Object.assign(new Error('Command rejected'), { response });
          return response;
        };
        const response = identityMutation
          ? await store.security.transaction({ ...replay, url: url.pathname }, raw, cloud, execute)
          : await store.transaction(execute, { req, url, raw });
        await finalizeWhatsApp(response);
        await finalizeSms(response);
        await finalizeUsage(response);
        await finalizeSupportGrant(response);
        // Send cookies/success only after PostgreSQL has committed the transaction.
        res.hanResponseBytes = Buffer.byteLength(response.body);
        res.writeHead(response.statusCode, response.headers);
        return res.end(response.body);
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        return res.end();
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!files.has(file)) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.setHeader(
        'Content-Type',
        {
          html: 'text/html; charset=utf-8',
          js: 'application/javascript; charset=utf-8',
          css: 'text/css; charset=utf-8',
          png: 'image/png',
        }[file.split('.').pop()],
      );
      if (req.method === 'HEAD') return res.end();
      res.end(await fs.promises.readFile(path.join(__dirname, '../outputs/icrapro', file)));
    } catch (error) {
      if (res.headersSent) {
        if (!res.destroyed) res.destroy(error);
        return;
      }
      if (error.response) {
        res.writeHead(error.response.statusCode, error.response.headers);
        return res.end(error.response.body);
      }
      if (error.code === '40001' || error.code === '40P01')
        error = Object.assign(Error('Başka bir işlem aynı kayıtları güncelledi. Yenileyip tekrar deneyin.'), {
          status: 409,
        });
      const status = error.status || 503;
      if (status === 428) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: error.message, code: 'employee_terms_required' }));
      }
      console.error('Request failed', {
        status,
        code: /^[A-Z0-9_]{3,30}$/.test(error.code || '') ? error.code : 'SERVER_ERROR',
      });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error:
            status === 413
              ? 'Veri boyutu sınırı aşıldı.'
              : error.publicMessage || [400, 401, 403, 404, 405, 409, 423, 429].includes(status)
                ? error.message
                : 'Sunucu hazır değil. Lütfen daha sonra tekrar deneyin.',
          // A short machine-readable cause the screen uses to explain what to check.
          ...(typeof error.reason === 'string' && /^[a-z_]{3,40}$/.test(error.reason)
            ? { reason: error.reason }
            : {}),
          ...(status === 423
            ? {
                code: error.code === 'CEO_PIN_REQUIRED' ? error.code : 'staff_on_break',
                ...(error.pinScope ? { pinScope: error.pinScope } : {}),
              }
            : {}),
        }),
      );
    }
  };
}
module.exports = { createApplication, files };

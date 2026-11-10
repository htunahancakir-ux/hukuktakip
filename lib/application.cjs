const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createAccess } = require('../outputs/icrapro/access-server.cjs');
const { createBackupService } = require('./backup-service.cjs');
const { createLocalBackupStore } = require('./local-backup-store.cjs');
const { event: auditEvent, requestEvents, auditQuery, createLocalAuditStore } = require('./audit.cjs');
const { deliverWhatsApp } = require('./whatsapp.cjs');
const { renderWhatsAppMedia } = require('./whatsapp-media.cjs');
const { REQUIRED_MESSAGE } = require('./employee-terms.cjs');
const { deliverScheduledReminders, schedulerAuthorized } = require('./scheduled-reminders.cjs');
const workspaceScripts = require('../outputs/icrapro/workspace-assets.js');
const { executeAccess, bufferedResponse, MAX_BODY, ATTACHMENT_BODY } = require('./access-executor.cjs');
const { mutationSourceAllowed, secureCookiesRequired } = require('./request-security.cjs');
const { readOnlyDenied, MESSAGE: READ_ONLY_MESSAGE } = require('./read-only-account.cjs');
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
  function scheduleMaintenance() {
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

  async function finalizeWhatsApp(response) {
    const batch = response.hanWhatsApp;
    if (!batch || response.statusCode < 200 || response.statusCode >= 300) return;
    const delivery = deliverWhatsApp(batch, { fetcher: whatsappFetch, renderMedia: renderWhatsAppMedia });
    if (batch.silent) {
      background(delivery.catch(() => {}));
      return;
    }
    const result = await delivery;
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
        if (
          [
            '/api/voip/webhook',
            '/api/voip/watchdog',
            '/api/voip/cron',
            '/api/voip/transcription-cron',
          ].includes(url.pathname)
        )
          return await handleVoip(req, res, url);
        if (url.pathname === '/api/scheduled-reminders/cron') {
          const secret = String(req.headers.authorization || '').replace(/^Bearer /, '');
          const result =
            req.method === 'POST' && store && /^[a-f0-9]{64}$/.test(secret)
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
        if (
          !['GET', 'HEAD'].includes(req.method) &&
          ![
            '/api/login',
            '/api/setup',
            '/api/logout',
            '/api/presence',
            '/api/password-reset/request',
            '/api/password-reset/complete',
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
            url.pathname === '/api/records/personnel-attachments'
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
          res.writeHead(buffered.statusCode, buffered.headers);
          return res.end(buffered.body);
        }
        const identityMutation =
          ['/api/login', '/api/logout'].includes(url.pathname) && req.method === 'POST';
        const rateChecked = await store.security.consumeAttempt(req, url.pathname, cloud);
        const execute = async (tx) => {
          const response = await executeAccess(tx, req, url, raw, {
            secureCookies,
            appOrigin,
            rateChecked,
            recordStore: !!store.recordQueries,
            mapsFetch,
            allowLocalServices: !cloud,
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

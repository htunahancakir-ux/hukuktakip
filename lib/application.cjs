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
const files = new Set([
  'index.html',
  'style.css',
  'workspace-layout.css',
  'workspace-assets.js',
  'login-recovery.js',
  'login-layout.js',
  'login-layout.css',
  'login-justice-v1.png',
  'employee-terms.js',
  'employee-terms-settings.js',
  'modal-dismissal.js',
  'auth.js',
  ...workspaceScripts,
]);
const MAX_BODY = 4 * 1024 * 1024;

function bufferedResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    },
    end(body = '') {
      this.body = body;
    },
  };
}

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
  background = (promise) => {
    void promise;
  },
} = {}) {
  const stateFile = process.env.HANHUKUK_STATE_FILE || path.resolve(__dirname, '../work/hanhukuk-state.json');
  const localReminderScheduler = !cloud && !store && process.env.HANHUKUK_LOCAL_REMINDER_DELIVERY === '1';
  const local = !cloud && !store ? createAccess(stateFile, { audit: true, localReminderScheduler }) : null;
  const audit = store || createLocalAuditStore(stateFile);
  const backups = createBackupService({
    store: store || createLocalBackupStore(stateFile),
    localDirectory: local ? path.join(path.dirname(stateFile), 'backups') : null,
    cloud,
    r2Client: backupR2Client,
  });

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

  async function managerUser(req) {
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
      await store.transaction(async (tx) => {
        const access = createAccess(null, {
          initialState: tx.state,
          saveState: tx.saveState,
          sessions: tx.sessions,
          attempts: tx.attempts,
          timers: false,
          allowSetup: false,
          requireRevision: true,
          secureCookies: cloud,
          appOrigin,
          maxBodyBytes: MAX_BODY,
        });
        await access(replay, response, url);
      });
    }
    const { user, employeeTermsRequired } = JSON.parse(response.body || '{}');
    if (!user || !['ceo', 'admin'].includes(user.role))
      throw Object.assign(new Error('Bu bölüm için yönetici girişi gerekli.'), { status: 403 });
    if (employeeTermsRequired) throw Object.assign(new Error(REQUIRED_MESSAGE), { status: 428 });
    return user;
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
      if (
        req.method !== 'GET' &&
        (req.headers['x-han-request'] !== '1' ||
          (req.headers.origin && req.headers.origin !== (appOrigin || `http://${req.headers.host}`)))
      )
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/scheduled-reminders/cron') {
          const secret = String(req.headers.authorization || '').replace(/^Bearer /, '');
          const result =
            req.method === 'POST' && store && /^[a-f0-9]{64}$/.test(secret)
              ? await deliverScheduledReminders(store.transaction, {
                  authorize: (state) => schedulerAuthorized(state, secret),
                  fetcher: whatsappFetch,
                })
              : null;
          res.writeHead(result ? 200 : 401, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(result || { error: 'Yetkisiz istek.' }));
        }
        if (url.pathname === '/api/backups' || url.pathname.startsWith('/api/backups/'))
          return handleBackup(req, res, url);
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
        if (
          !local &&
          ['/api/search', '/api/scheduled-reminders'].includes(url.pathname) &&
          req.method === 'GET'
        ) {
          const { state, sessions } = await store.readSessionContext();
          const search = createAccess(null, {
            initialState: state,
            sessions,
            timers: false,
            allowSetup: false,
            reminderScheduler: true,
          });
          return await search(req, res, url);
        }
        const raw = await readBody(req, local ? 25 * 1024 * 1024 : MAX_BODY);
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
        const response = await store.transaction(async (tx) => {
          const buffered = bufferedResponse();
          const access = createAccess(null, {
            initialState: tx.state,
            saveState: tx.saveState,
            sessions: tx.sessions,
            attempts: tx.attempts,
            timers: false,
            allowSetup: false,
            requireRevision: true,
            secureCookies: cloud,
            appOrigin,
            maxBodyBytes: MAX_BODY,
            audit: true,
            reminderScheduler: true,
          });
          await access(replay, buffered, url);
          if (Buffer.byteLength(buffered.body) > MAX_BODY)
            throw Object.assign(new Error('Response too large'), { status: 413 });
          await tx.appendAudit(requestEvents(req, url, raw, buffered));
          return buffered;
        });
        await finalizeWhatsApp(response);
        // Send cookies/success only after PostgreSQL has committed the transaction.
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
              : [400, 403, 405].includes(status)
                ? error.message
                : 'Sunucu hazır değil. Lütfen daha sonra tekrar deneyin.',
        }),
      );
    }
  };
}
module.exports = { createApplication, files };

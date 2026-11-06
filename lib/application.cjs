const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createAccess } = require('../outputs/icrapro/access-server.cjs');
const { createBackupService } = require('./backup-service.cjs');
const { createLocalBackupStore } = require('./local-backup-store.cjs');
const files = new Set(['index.html','profit-rules.js','phone-format.js','auth.js','parking-fees.js',
  'document-types.js','personnel.js','settings.js','districts.js','dashboard.js','app.js','style.css']);
const MAX_BODY = 4 * 1024 * 1024;

function bufferedResponse() {
  return { statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { this.statusCode = status; for (const [k,v] of Object.entries(headers)) this.setHeader(k,v); },
    end(body = '') { this.body = body; }
  };
}

async function readBody(req) {
  let buffer;
  if (req.body !== undefined) buffer = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  else {
    const chunks = []; let length = 0;
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk);
      if (length > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  }
  if (buffer.length > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
  return buffer;
}

function createApplication({ store, cloud = false, appOrigin = process.env.APP_ORIGIN, backupR2Client } = {}) {
  const stateFile = process.env.HANHUKUK_STATE_FILE || path.resolve(__dirname, '../work/hanhukuk-state.json');
  const local = !cloud && !store ? createAccess(stateFile) : null;
  const backups = createBackupService({
    store: store || createLocalBackupStore(stateFile),
    localDirectory: local ? path.join(path.dirname(stateFile), 'backups') : null,
    cloud,
    r2Client: backupR2Client
  });

  async function backupUser(req) {
    const replay = { method: 'GET', headers: req.headers, socket: req.socket,
      async *[Symbol.asyncIterator]() {} };
    const url = new URL('/api/session', 'http://localhost');
    const response = bufferedResponse();
    if (local) await local(replay, response, url);
    else await store.transaction(async tx => {
      const access = createAccess(null, { initialState: tx.state, saveState: tx.saveState,
        sessions: tx.sessions, attempts: tx.attempts, timers: false,
        allowSetup: false, requireRevision: true, secureCookies: cloud,
        appOrigin, maxBodyBytes: MAX_BODY });
      await access(replay, response, url);
    });
    const user = JSON.parse(response.body || '{}').user;
    if (!user || !['ceo', 'admin'].includes(user.role))
      throw Object.assign(new Error('Yedekleme ayarları için yönetici girişi gerekli.'), { status: 403 });
    return user;
  }

  async function handleBackup(req, res, url) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === '/api/backups/cron') {
        const expected = process.env.CRON_SECRET || '';
        const received = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const a = Buffer.from(expected), b = Buffer.from(received);
        if (req.method !== 'GET' || !expected || a.length !== b.length || !require('node:crypto').timingSafeEqual(a, b))
          return send(401, { error: 'Yetkisiz istek.' });
        return send(200, await backups.run());
      }
      if (!['GET', 'PUT', 'POST'].includes(req.method)) return send(405, { error: 'İşlem desteklenmiyor.' });
      if (req.method !== 'GET' && (req.headers['x-han-request'] !== '1' ||
        (req.headers.origin && req.headers.origin !== (appOrigin || `http://${req.headers.host}`))))
        return send(403, { error: 'İstek kaynağı doğrulanamadı.' });
      const user = await backupUser(req);
      if (['/api/backups/files', '/api/backups/download'].includes(url.pathname) && user.role !== 'ceo')
        return send(403, { error: 'Yedek dosyalarına yalnızca CEO erişebilir.' });
      if (url.pathname === '/api/backups' && req.method === 'GET') return send(200, await backups.status());
      if (url.pathname === '/api/backups/files' && req.method === 'GET')
        return send(200, await backups.list(url.searchParams.get('month')));
      if (url.pathname === '/api/backups/download' && req.method === 'GET') {
        return await backups.download(url.searchParams.get('key'), async (body, filename) => {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'private, no-store'
          });
          await pipeline(body, res);
        });
      }
      if (url.pathname === '/api/backups' && req.method === 'PUT')
        return send(200, await backups.configure(JSON.parse((await readBody(req)).toString() || '{}')));
      if (url.pathname === '/api/backups/run' && req.method === 'POST') return send(200, await backups.run({ force: true }));
      return send(404, { error: 'İşlem bulunamadı.' });
    } catch (error) {
      console.error('Backup request failed', { status: error.status || 503, name: error.cause?.name || error.name });
      if (res.headersSent || res.destroyed) return res.destroy();
      return send(error.status || 503, { error: error.message && error.status ? error.message : 'Yedekleme işlemi tamamlanamadı.' });
    }
  }

  if (local) {
    const timer = setInterval(() => backups.run().catch(error =>
      console.error('Scheduled backup failed', { name: error.cause?.name || error.name })), 15 * 60000);
    timer.unref();
  }
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/backups' || url.pathname.startsWith('/api/backups/'))
          return handleBackup(req, res, url);
        if (local) return await local(req, res, url);
        if (!store || (cloud && !appOrigin)) throw Object.assign(new Error('Server configuration incomplete'), { status: 503 });
        const raw = await readBody(req); // Do not hold a database lock while waiting on the network.
        const replay = { method: req.method, headers: req.headers, socket: req.socket,
          async *[Symbol.asyncIterator]() { if(raw.length) yield raw; } };
        const response = await store.transaction(async tx => {
          const buffered = bufferedResponse();
          const access = createAccess(null, { initialState: tx.state, saveState: tx.saveState,
            sessions: tx.sessions, attempts: tx.attempts, timers: false,
            allowSetup: false, requireRevision: true, secureCookies: cloud,
            appOrigin, maxBodyBytes: MAX_BODY });
          await access(replay, buffered, url);
          if (Buffer.byteLength(buffered.body) > MAX_BODY)
            throw Object.assign(new Error('Response too large'), { status: 413 });
          return buffered;
        });
        // Send cookies/success only after PostgreSQL has committed the transaction.
        res.writeHead(response.statusCode, response.headers);
        return res.end(response.body);
      }
      if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!files.has(file)) { res.writeHead(404); return res.end('Not found'); }
      res.setHeader('Content-Type', { html:'text/html; charset=utf-8', js:'application/javascript; charset=utf-8', css:'text/css; charset=utf-8' }[file.split('.').pop()]);
      if (req.method === 'HEAD') return res.end();
      res.end(await fs.promises.readFile(path.join(__dirname, '../outputs/icrapro', file)));
    } catch (error) {
      const status = error.status || 503;
      console.error('Request failed', { status, code: /^[A-Z0-9_]{3,30}$/.test(error.code || '') ? error.code : 'SERVER_ERROR' });
      res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 413 ? 'Veri boyutu sınırı aşıldı.' : 'Sunucu hazır değil. Lütfen daha sonra tekrar deneyin.' }));
    }
  };
}
module.exports = { createApplication, files };

const fs = require('node:fs');
const path = require('node:path');
const { createAccess } = require('../outputs/icrapro/access-server.cjs');
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

function createApplication({ store, cloud = false, appOrigin = process.env.APP_ORIGIN } = {}) {
  const local = !cloud && !store ? createAccess(process.env.HANHUKUK_STATE_FILE || path.resolve(__dirname, '../work/hanhukuk-state.json')) : null;
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Screenshots go to an encrypted local folder in tests (R2 is not configured here).
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
process.env.HANHUKUK_FEEDBACK_DIR = folder;
process.env.FEEDBACK_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { password, fixture, database, serve } = require('./support/postgres.cjs');

// A tiny JPEG: only the start marker is checked by the server.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('synthetic screenshot bytes'),
]);
const jpegUrl = 'data:image/jpeg;base64,' + JPEG.toString('base64');

function people() {
  const state = fixture();
  const base = state.users[0];
  state.users.push(
    { ...base, id: 'fb-staff', username: 'staff', name: 'Personel Bir', role: 'staff' },
    { ...base, id: 'fb-other', username: 'other', name: 'Personel İki', role: 'staff' },
    { ...base, id: 'fb-admin', username: 'admin', name: 'Yönetici', role: 'admin' },
    { ...base, id: 'fb-viewer', username: 'viewer', name: 'İzleyici', role: 'staff', readOnly: true },
  );
  return state;
}

async function start(state) {
  const { pg, pool } = await database();
  await importState(pool, state);
  const pending = [];
  const open = async () =>
    serve(createApplication({ store: createStore(pool), background: (t) => pending.push(t) }));
  let app = await open();
  const send = (route, input, { cookie, method = 'POST' } = {}) =>
    fetch(app.url + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1', ...(cookie && { cookie }) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }),
    });
  const get = (route, cookie) => send(route, null, { cookie, method: 'GET' });
  const cookieFor = async (username) =>
    (await send('/api/login', { username, password })).headers.get('set-cookie').split(';')[0];
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    send,
    get,
    cookieFor,
    // A fresh application on the same database: proves entries were saved, not just cached.
    async restart() {
      await settle();
      await app.close();
      app = await open();
    },
    async close() {
      await settle();
      await app.close();
      await pg.close();
    },
  };
}

test('feedback: staff send with a screenshot, see only their own; managers see all and answer', async () => {
  const app = await start(people());
  try {
    const staff = await app.cookieFor('staff');
    const other = await app.cookieFor('other');

    const sent = await app.send(
      '/api/feedback',
      { kind: 'bug', target: 'support', message: 'Föy kaydedilmiyor', page: '/#docs', screenshot: jpegUrl },
      { cookie: staff },
    );
    assert.equal(sent.status, 200);
    const result = await sent.json();
    assert.equal(result.screenshotSaved, true);
    assert.equal(result.item.status, 'open');
    assert.equal(result.item.userName, 'Personel Bir');
    assert.equal(result.item.screenshot, true);
    const id = result.item.id;

    // Stored encrypted: the raw bytes never appear on disk.
    const file = path.join(folder, 'geri-bildirim', id + '.enc');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(file).includes(Buffer.from('synthetic screenshot')), false);

    assert.equal(
      (await app.send('/api/feedback', { kind: 'question', message: 'Rapor nerede?' }, { cookie: other }))
        .status,
      200,
    );

    const mine = await (await app.get('/api/feedback', staff)).json();
    assert.equal(mine.manager, false);
    assert.deepEqual(
      mine.items.map((f) => f.message),
      ['Föy kaydedilmiyor'],
    );
    assert.equal(
      (await app.get('/api/feedback/screenshot?id=' + id, other)).status,
      404,
      'Others cannot open it',
    );
    const shot = await (await app.get('/api/feedback/screenshot?id=' + id, staff)).json();
    assert.equal(shot.dataUrl, jpegUrl);

    assert.equal(
      (await app.send('/api/feedback/reply', { id, message: 'x' }, { cookie: staff })).status,
      403,
    );

    await app.restart();
    const ceo = await app.cookieFor('test');
    const all = await (await app.get('/api/feedback', ceo)).json();
    assert.equal(all.manager, true);
    assert.equal(all.screenshotsAvailable, true);
    assert.deepEqual(
      all.items.map((f) => f.message),
      ['Rapor nerede?', 'Föy kaydedilmiyor'],
      'Newest first, kept after a restart',
    );
    assert.equal((await (await app.get('/api/feedback/screenshot?id=' + id, ceo)).json()).dataUrl, jpegUrl);

    const admin = await app.cookieFor('admin');
    const answered = await (
      await app.send(
        '/api/feedback/reply',
        { id, message: 'Düzeltildi, sayfayı yenileyin.' },
        { cookie: admin },
      )
    ).json();
    assert.equal(answered.item.status, 'answered');
    assert.equal(answered.item.replies[0].by, 'Yönetici');
    const closed = await (
      await app.send('/api/feedback/reply', { id, status: 'closed' }, { cookie: ceo })
    ).json();
    assert.equal(closed.item.status, 'closed');
    assert.equal(closed.item.replies.length, 1);

    const seen = await (await app.get('/api/feedback', staff)).json();
    assert.equal(seen.items[0].status, 'closed');
    assert.equal(seen.items[0].replies[0].message, 'Düzeltildi, sayfayı yenileyin.');
  } finally {
    await app.close();
  }
});

test('feedback: input is checked; read-only accounts can still send', async () => {
  const app = await start(people());
  try {
    const staff = await app.cookieFor('staff');
    const post = (input, cookie = staff) => app.send('/api/feedback', input, { cookie });
    assert.equal((await post({ kind: 'complaint', message: 'Merhaba' })).status, 400);
    assert.equal((await post({ kind: 'bug', message: 'x' })).status, 400, 'Too short');
    assert.equal((await post({ kind: 'bug', message: 'a'.repeat(3001) })).status, 400, 'Too long');
    assert.equal((await post({ kind: 'bug', target: 'sales', message: 'Satış sorusu' })).status, 400);
    const png = 'data:image/png;base64,' + Buffer.from('not a jpeg').toString('base64');
    assert.equal((await post({ kind: 'bug', message: 'Resim', screenshot: png })).status, 400);
    const fake = 'data:image/jpeg;base64,' + Buffer.from('not a jpeg').toString('base64');
    assert.equal((await post({ kind: 'bug', message: 'Resim', screenshot: fake })).status, 400);
    assert.equal((await app.get('/api/feedback', null)).status, 401, 'Sign-in required');

    const viewer = await app.cookieFor('viewer');
    assert.equal((await post({ kind: 'suggestion', message: 'Koyu tema olsun' }, viewer)).status, 200);
    const ceo = await app.cookieFor('test');
    const [entry] = (await (await app.get('/api/feedback', ceo)).json()).items;
    assert.equal(entry.message, 'Koyu tema olsun');
    assert.equal(entry.screenshot, false);
    // Read-only managers still cannot answer (only sending is allowed).
    assert.equal(
      (await app.send('/api/feedback/reply', { id: entry.id, message: 'Tamam' }, { cookie: viewer })).status,
      403,
    );
  } finally {
    await app.close();
  }
});

test('feedback screenshot capture is served and the window loads it on demand', () => {
  const { files } = require('../lib/application.cjs');
  assert.ok(files.has('html2canvas.min.js'));
  assert.ok(require('../outputs/icrapro/workspace-assets.js').includes('workspace-feedback.js'));
  const source = fs.readFileSync('outputs/icrapro/workspace-feedback.js', 'utf8');
  assert.match(source, /loadClassicScript\('html2canvas\.min\.js'\)/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { database, fixture, serve, password } = require('./support/postgres.cjs');
const { createStore, importState } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { createTenant } = require('../lib/saas/tenants.cjs');
const { parseImage: parseUpload, parseTexts } = require('../lib/office-branding.cjs');

// A real 1×1 PNG; the server only accepts files whose bytes say JPEG, PNG or WebP.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]).toString('base64');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
const headers = { 'Content-Type': 'application/json', 'X-Han-Request': '1' };

function withStaff(state) {
  state.users.push(
    { ...state.users[0], id: 'staff', name: 'Personel', username: 'staff', role: 'user' },
    { ...state.users[0], id: 'manager', name: 'Yönetici', username: 'manager', role: 'admin' },
  );
  return state;
}

async function signIn(base, username) {
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200, username);
  return { ...headers, cookie: login.headers.get('set-cookie').split(';')[0] };
}

test('only JPEG, PNG and WebP files up to the size limit are accepted, by their bytes', () => {
  assert.equal(parseUpload({ data: png }).contentType, 'image/png');
  assert.equal(parseUpload({ data: jpeg }).contentType, 'image/jpeg');
  assert.equal(parseUpload({ data: webp }).contentType, 'image/webp');
  assert.match(parseUpload({ data: png }).digest, /^[a-f0-9]{64}$/);
  for (const data of [svg, Buffer.from('GIF89a').toString('base64')])
    assert.throws(() => parseUpload({ data }), { status: 400, message: /JPG, PNG veya WebP/ });
  assert.throws(() => parseUpload({ data: 'not base64!' }), { status: 400 });
  assert.throws(() => parseUpload({}), { status: 400 });
  const big = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(1600 * 1024)]).toString('base64');
  assert.throws(() => parseUpload({ data: big }), { status: 400, message: /1,5 MB/ });
});

test('the login picture is public, managers change it, and each office keeps its own', async (t) => {
  const { pg, pool } = await database();
  await importState(pool, withStaff(fixture()));
  const store = createStore(pool);
  const app = await serve(createApplication({ store }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });

  // No picture of its own yet: the built-in one.
  let response = await fetch(app.url + '/api/login-art', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login-justice-v1.png');

  // Only signed-in CEO and admins may change it, and only from the application itself.
  response = await fetch(app.url + '/api/login-art', { method: 'PUT', body: JSON.stringify({ data: png }) });
  assert.equal(response.status, 403);
  response = await fetch(app.url + '/api/login-art', { method: 'PUT', headers, body: JSON.stringify({ data: png }) });
  assert.equal(response.status, 403);
  const staff = await signIn(app.url, 'staff');
  response = await fetch(app.url + '/api/login-art', { method: 'PUT', headers: staff, body: JSON.stringify({ data: png }) });
  assert.equal(response.status, 403);
  response = await fetch(app.url + '/api/login-art/status', { headers: staff });
  assert.equal(response.status, 403);

  const ceo = await signIn(app.url, 'test');
  response = await fetch(app.url + '/api/login-art', { method: 'PUT', headers: ceo, body: JSON.stringify({ data: svg }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JPG, PNG veya WebP/);

  response = await fetch(app.url + '/api/login-art', { method: 'PUT', headers: ceo, body: JSON.stringify({ data: png }) });
  assert.equal(response.status, 200);
  const { digest } = await response.json();

  // Anyone can load it, with its own type; an unchanged picture is not sent again.
  response = await fetch(app.url + '/api/login-art');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'));
  const etag = response.headers.get('etag');
  assert.equal(etag, `"${digest}"`);
  response = await fetch(app.url + '/api/login-art', { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 304);

  // An admin sees and can change it too.
  const manager = await signIn(app.url, 'manager');
  response = await fetch(app.url + '/api/login-art/status', { headers: manager });
  const status = await response.json();
  assert.equal(status.custom, true);
  assert.equal(status.digest, digest);
  assert.equal(status.updatedBy, 'Test');
  response = await fetch(app.url + '/api/login-art', { method: 'PUT', headers: manager, body: JSON.stringify({ data: jpeg }) });
  assert.equal(response.status, 200);
  assert.equal((await fetch(app.url + '/api/login-art')).headers.get('content-type'), 'image/jpeg');

  // Another office has its own picture, or the built-in one; never this office's.
  const other = await createTenant(pool, { slug: 'diger-buro', name: 'Diğer Büro', ownerUserId: 'owner' });
  const otherStore = createStore(pool, { tenantId: other.id });
  assert.equal(await otherStore.branding.get('login-art'), null);
  await otherStore.branding.set('login-art', parseUpload({ data: webp }), { id: 'o', name: 'Öteki' });
  assert.equal((await otherStore.branding.get('login-art')).contentType, 'image/webp');
  assert.equal((await store.branding.get('login-art')).contentType, 'image/jpeg');

  // Every change is in the office's audit log.
  const audit = await store.listAudit({ category: 'changes' });
  const entries = audit.items.filter((item) => item.area === 'Firma Ayarları');
  assert.deepEqual(
    entries.map((item) => [item.actor_name, item.fields]).sort(),
    [
      ['Test', ['Giriş ekranı görseli değiştirildi']],
      ['Yönetici', ['Giriş ekranı görseli değiştirildi']],
    ].sort(),
  );
  assert.equal(
    (await otherStore.listAudit({ category: 'changes' })).items.some((item) => item.actor_name === 'Test'),
    false,
  );

  // Back to the built-in picture.
  response = await fetch(app.url + '/api/login-art', { method: 'DELETE', headers: ceo });
  assert.equal(response.status, 200);
  response = await fetch(app.url + '/api/login-art', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal((await otherStore.branding.get('login-art')).contentType, 'image/webp');
});

test('in single state file mode the picture is kept next to the state file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'han-login-art-')),
    stateFile = path.join(directory, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(withStaff(fixture())));
  const previous = process.env.HANHUKUK_STATE_FILE;
  process.env.HANHUKUK_STATE_FILE = stateFile;
  let app;
  try {
    app = await serve(createApplication());
    const ceo = await signIn(app.url, 'test');
    let response = await fetch(app.url + '/api/login-art', {
      method: 'PUT',
      headers: ceo,
      body: JSON.stringify({ data: png }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    response = await fetch(app.url + '/api/login-art');
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.ok(fs.existsSync(path.join(directory, 'office-branding-login-art.json')));
    const staff = await signIn(app.url, 'staff');
    response = await fetch(app.url + '/api/login-art', { method: 'DELETE', headers: staff });
    assert.equal(response.status, 403);
    response = await fetch(app.url + '/api/login-art', { method: 'DELETE', headers: ceo });
    assert.equal(response.status, 200);
    response = await fetch(app.url + '/api/login-art', { redirect: 'manual' });
    assert.equal(response.status, 302);
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.HANHUKUK_STATE_FILE;
    else process.env.HANHUKUK_STATE_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const sample = (overrides = {}) => ({
  id: 'baslik',
  text: 'Her dosyada özen.',
  style: 'heading',
  color: 'white',
  bold: false,
  x: 15,
  y: 81.5,
  size: 5.7,
  ...overrides,
});

test('login texts are a short list of plain texts with known styles, places and sizes', () => {
  const parsed = parseTexts({ texts: [sample(), sample({ id: 'b', text: ' Satır 1\r\nSatır 2\u0007 ', x: 0, y: 100 })] });
  assert.equal(parsed.contentType, 'application/json');
  assert.deepEqual(JSON.parse(parsed.body), parsed.texts);
  assert.equal(parsed.texts[1].text, 'Satır 1\nSatır 2');
  assert.deepEqual(parseTexts({ texts: [] }).texts, []);
  const bad = [
    { texts: 'x' },
    { texts: Array.from({ length: 13 }, (_, i) => sample({ id: 'y' + i })) },
    { texts: [sample(), sample()] },
    { texts: [sample({ id: 'Büyük Harf' })] },
    { texts: [sample({ style: 'html' })] },
    { texts: [sample({ color: 'red' })] },
    { texts: [sample({ bold: 'yes' })] },
    { texts: [sample({ text: '   ' })] },
    { texts: [sample({ text: 'x'.repeat(301) })] },
    { texts: [sample({ text: '1\n2\n3\n4\n5\n6\n7' })] },
    { texts: [sample({ x: -1 })] },
    { texts: [sample({ y: 101 })] },
    { texts: [sample({ size: 0.5 })] },
    { texts: [sample({ size: 15 })] },
    { texts: [sample({ x: '15' })] },
    { texts: [sample({ size: Number.NaN })] },
  ];
  for (const input of bad) assert.throws(() => parseTexts(input), { status: 400 }, JSON.stringify(input).slice(0, 80));
});

test('login texts are public to read, managers save them, and each office keeps its own', async (t) => {
  const { pg, pool } = await database();
  await importState(pool, withStaff(fixture()));
  const store = createStore(pool);
  const app = await serve(createApplication({ store }));
  t.after(async () => {
    await app.close();
    await pg.close();
  });
  let response = await fetch(app.url + '/api/login-texts');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { texts: null });

  const texts = [
    sample(),
    sample({ id: 'xss', text: '<img src=x onerror="window.pwned=1">', style: 'text', color: 'gold', bold: true, size: 2 }),
  ];
  const staff = await signIn(app.url, 'staff');
  response = await fetch(app.url + '/api/login-texts', { method: 'PUT', headers: staff, body: JSON.stringify({ texts }) });
  assert.equal(response.status, 403);
  response = await fetch(app.url + '/api/login-texts', { method: 'PUT', headers, body: JSON.stringify({ texts }) });
  assert.equal(response.status, 403);

  const ceo = await signIn(app.url, 'test');
  response = await fetch(app.url + '/api/login-texts', {
    method: 'PUT',
    headers: ceo,
    body: JSON.stringify({ texts: [sample({ style: 'script' })] }),
  });
  assert.equal(response.status, 400);
  response = await fetch(app.url + '/api/login-texts', { method: 'PUT', headers: ceo, body: JSON.stringify({ texts }) });
  assert.equal(response.status, 200);

  // Before sign-in the login screen reads them back as data; the screen writes them as text.
  response = await fetch(app.url + '/api/login-texts');
  assert.deepEqual((await response.json()).texts, texts);

  const other = await createTenant(pool, { slug: 'diger-buro', name: 'Diğer Büro', ownerUserId: 'owner' });
  const otherStore = createStore(pool, { tenantId: other.id });
  assert.equal(await otherStore.branding.get('login-texts'), null);

  const audit = await store.listAudit({ category: 'changes' });
  assert.ok(audit.items.some((item) => item.fields?.includes('Giriş ekranı yazıları değiştirildi')));

  response = await fetch(app.url + '/api/login-texts', { method: 'DELETE', headers: ceo });
  assert.equal(response.status, 200);
  assert.deepEqual(await (await fetch(app.url + '/api/login-texts')).json(), { texts: null });
});

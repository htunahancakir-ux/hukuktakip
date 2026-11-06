const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { PGlite } = require('@electric-sql/pglite');
const { migrate, importState, createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');
const { encryptState } = require('../lib/backup-service.cjs');
const { restoreBackup } = require('../scripts/restore-backup.cjs');

const password = 'Synthetic-Postgres-Test-Only';
function fixture() {
  const salt = crypto.randomBytes(16).toString('hex');
  return { users: [{ id:'test-ceo', name:'Test', username:'test', role:'ceo', active:true, permissions:[],
    salt, hash:crypto.scryptSync(password,salt,64).toString('hex') }], data: {
    'icrapro-v1': { clients:[], docs:[] }, 'icrapro-personnel-v1':[], 'icrapro-settings-v1':{},
    'hanhukuk-finance-v1':[], 'hanhukuk-accounting-v1':{accounts:[],entries:[]}, 'icrapro-cases-v1':[]
  }};
}

// PGlite executes actual PostgreSQL SQL; one local connection is queued here.
// A separate integration test against Supabase is still required before deployment.
async function database() {
  const pg = new PGlite(); let queue = Promise.resolve();
  const query = async (sql, params) => {
    if (!params && sql.includes('CREATE SCHEMA')) { await pg.exec(sql); return {rows:[]}; }
    return pg.query(sql, params);
  };
  const pool = { query, async connect() {
    const previous = queue; let release; queue = new Promise(r => release = r); await previous;
    return { query, release };
  }};
  await migrate(pool);
  return {pg,pool};
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  return { url:'http://127.0.0.1:'+server.address().port,
    async close(){ server.closeAllConnections(); await new Promise(r=>server.close(r)); } };
}

test('PostgreSQL import preserves all fields and refuses overwrite', async () => {
  const {pg,pool}=await database();
  try {
    const state=fixture();state.customMetadata={text:'Türkçe kayıt',amount:12345};
    await importState(pool,state);
    assert.deepEqual((await pool.query('SELECT payload FROM han_private.han_state')).rows[0].payload,state);
    await assert.rejects(importState(pool,fixture()),e=>e.code==='23505');
    assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='han_state'")).rows[0].relrowsecurity,true);
  } finally {await pg.close();}
});

test('Two application instances share sessions, reject stale writes, persist logout and rate limits', async()=>{
  const {pg,pool}=await database();await importState(pool,fixture());
  const store=createStore(pool);
  const one=await serve(createApplication({store})),two=await serve(createApplication({store}));
  try {
    const headers={'Content-Type':'application/json','X-Han-Request':'1'};
    const login=await fetch(one.url+'/api/login',{method:'POST',headers,body:JSON.stringify({username:'test',password})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const stored=(await pool.query('SELECT sessions FROM han_private.han_state')).rows[0].sessions;
    assert.ok(!Object.hasOwn(stored,cookie.split('=')[1]),'Only token hashes are stored');
    const session=await(await fetch(two.url+'/api/session',{headers:{cookie}})).json();assert.equal(session.user.id,'test-ceo');
    const url='/api/data?key=icrapro-settings-v1';
    const old=await fetch(one.url+url,{headers:{cookie}});const etag=old.headers.get('etag');
    const put=async(base,value,tag)=>fetch(base+url,{method:'PUT',headers:{...headers,cookie,...(tag?{'If-Match':tag}:{})},body:JSON.stringify({value})});
    assert.equal((await put(one.url,{firm:{name:'New'}},null)).status,428);
    const written=await put(one.url,{firm:{name:'New'}},etag);assert.equal(written.status,200);
    assert.notEqual(written.headers.get('etag'),etag);
    assert.equal((await put(two.url,{firm:{name:'Stale'}},etag)).status,409);
    assert.equal((await(await fetch(two.url+url,{headers:{cookie}})).json()).firm.name,'New');
    const setup=await fetch(one.url+'/api/setup',{method:'POST',headers,body:'{}'});assert.equal(setup.status,403);
    assert.equal((await fetch(one.url+'/api/logout',{method:'POST',headers:{...headers,cookie},body:'{}'})).status,200);
    assert.equal((await(await fetch(two.url+'/api/session',{headers:{cookie}})).json()).user,null);
    for(let i=0;i<8;i++)assert.equal((await fetch((i%2?one:two).url+'/api/login',{method:'POST',headers,body:JSON.stringify({username:'test',password:'wrong'})})).status,401);
    assert.equal((await fetch(two.url+'/api/login',{method:'POST',headers,body:JSON.stringify({username:'test',password})})).status,429);
  } finally {await one.close();await two.close();await pg.close();}
});

test('Transaction failure rolls back state; buffered response prevents false success',async()=>{
  const {pg,pool}=await database();await importState(pool,fixture());const store=createStore(pool);
  try {
    await assert.rejects(store.transaction(async tx=>{tx.state.data['icrapro-settings-v1']={broken:true};tx.saveState(tx.state);throw Error('Synthetic failure')}));
    assert.deepEqual((await pool.query('SELECT payload FROM han_private.han_state')).rows[0].payload.data['icrapro-settings-v1'],{});
    const broken={transaction:async work=>{await store.transaction(work);throw Error('Synthetic commit failure')}};
    const app=await serve(createApplication({store:broken}));
    try {const response=await fetch(app.url+'/api/login',{method:'POST',headers:{'X-Han-Request':'1','Content-Type':'application/json'},body:JSON.stringify({username:'test',password})});assert.equal(response.status,503);assert.equal(response.headers.get('set-cookie'),null);}finally{await app.close()}
  }finally{await pg.close()}
});

test('Vercel mode fails closed without database and accepts only configured HTTPS origin',async()=>{
  const unavailable=await serve(createApplication({cloud:true}));
  try {assert.equal((await fetch(unavailable.url+'/api/session')).status,503)}finally{await unavailable.close()}
  const {pg,pool}=await database();await importState(pool,fixture());
  const app=await serve(createApplication({cloud:true,store:createStore(pool),appOrigin:'https://example.invalid'}));
  try {
    const request=origin=>fetch(app.url+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Han-Request':'1'},body:JSON.stringify({username:'test',password})});
    assert.equal((await request('https://attacker.invalid')).status,403);
    const response=await request('https://example.invalid');assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/; Secure/);
    assert.equal((await fetch(app.url+'/work/hanhukuk-state.json')).status,404);
    assert.equal((await fetch(app.url+'/access-server.cjs')).status,404);
  }finally{await app.close();await pg.close()}
});

test('Only the CEO can download and restore a backup, and restore refuses to overwrite', async t => {
  for (const [name, value] of Object.entries({ R2_ACCOUNT_ID: 'test', R2_BUCKET_NAME: 'test',
    R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test' })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const state = fixture();
  state.users.push({ ...state.users[0], id: 'test-admin', username: 'admin', role: 'admin' });
  const filename = '2026-11-06T20-00-00-000Z-00000000-0000-4000-8000-000000000001.hnb';
  const legacyKey = 'hanhukuk/' + filename;
  const newKey = 'hanhukuk/production/' + filename.replace('11-06', '11-07');
  state.backupPolicy = { lastObjectKey: newKey, legacyObjectKey: legacyKey };
  const encryptionKey = crypto.randomBytes(32);
  const encrypted = encryptState(state, encryptionKey);
  const { pg, pool } = await database();
  t.after(() => pg.close());
  await importState(pool, state);
  const r2Client = () => ({
    destroy() {},
    async send(command) {
      const { Key, Prefix } = command.input;
      if (Prefix === 'hanhukuk/production/2026-11-')
        return { Contents: [{ Key: newKey, Size: encrypted.length }] };
      assert.equal(Key, legacyKey);
      return { ContentLength: encrypted.length, Metadata: { format: 'hanhukuk-backup-v1' },
        ...(command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([encrypted]) } : {}) };
    }
  });
  const app = await serve(createApplication({ cloud: true, store: createStore(pool),
    appOrigin: 'https://example.invalid', backupR2Client: r2Client }));
  try {
    async function login(username) {
      const response = await fetch(app.url + '/api/login', {
        method: 'POST', headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get('set-cookie').split(';')[0] };
    }
    const ceo = await login('test');
    const admin = await login('admin');
    const list = app.url + '/api/backups/files?month=2026-11';
    const download = key => app.url + '/api/backups/download?key=' + encodeURIComponent(key);
    assert.equal((await fetch(list)).status, 403);
    assert.equal((await fetch(list, { headers: admin })).status, 403);
    assert.equal((await fetch(download(legacyKey), { headers: admin })).status, 403);
    assert.equal((await fetch(download('hanhukuk/local/' + filename), { headers: ceo })).status, 404);
    const listed = await (await fetch(list, { headers: ceo })).json();
    assert.deepEqual(listed.backups.map(row => row.key), [newKey, legacyKey]);
    const response = await fetch(download(legacyKey), { headers: ceo });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="hanhukuk-canli-${filename}"`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(downloaded, encrypted);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'han-restore-'));
    const file = path.join(directory, 'download.hnb');
    const localTarget = path.join(directory, 'recovered.json');
    try {
      await fs.writeFile(file, downloaded);
      const restore = username => restoreBackup({ file, localTarget, rawKey: encryptionKey.toString('hex'),
        credentials: async () => ({ username, password }) });
      await assert.rejects(restore('admin'), /etkin CEO/);
      await assert.rejects(fs.stat(localTarget), { code: 'ENOENT' });
      await restore('test');
      const { backupPolicy, ...expected } = state;
      assert.deepEqual(JSON.parse(await fs.readFile(localTarget, 'utf8')), expected);
      await assert.rejects(restore('test'), /Hedef dosya zaten var/);
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(localTarget, { force: true });
      await fs.rmdir(directory);
    }
  } finally { await app.close(); }
});

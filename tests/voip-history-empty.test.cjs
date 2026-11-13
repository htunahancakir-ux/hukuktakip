const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { password, fixture, serve } = require('./support/postgres.cjs');

// Compatibility (single state file) mode: an office that has never placed a call has no call
// list in its state. Opening a borrower sheet asks for the call history and must get an empty
// list, not "503 Sunucu hazır değil".
test('Call history of a file answers an empty list when the office has no call records', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'han-voip-history-')),
    stateFile = path.join(directory, 'state.json'),
    state = fixture();
  state.data['icrapro-v1'].docs.push({ id: 'd1', number: 'D-001', debtor: 'Borçlu', status: 'Derdest' });
  assert.equal(state.voipCalls, undefined);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const previous = process.env.HANHUKUK_STATE_FILE;
  process.env.HANHUKUK_STATE_FILE = stateFile;
  let app;
  try {
    app = await serve(require('../lib/application.cjs').createApplication());
    const login = await fetch(app.url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
      body: JSON.stringify({ username: 'test', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(app.url + '/api/voip/history?documentId=d1&result=&offset=0', {
      headers: { cookie, 'X-Han-Request': '1' },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.total, 0);
    assert.deepEqual(body.rows, []);
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.HANHUKUK_STATE_FILE;
    else process.env.HANHUKUK_STATE_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

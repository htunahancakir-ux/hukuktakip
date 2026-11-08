const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { JSDOM } = require('jsdom');
test('Cash form preserves request ID on failure, suppresses double submit and does not overwrite a different page', async (t) => {
  const dom = new JSDOM(
    '<div id="content"><p>Accounts</p></div><dialog open><form><input name="type" value="transfer"><input name="amount" value="10"><input name="accountId" value="a"><input name="destination" value="b"><input name="date" value="2026-01-02"><input name="note" value="Test"><button class="primary">Save</button></form></dialog>',
    { url: 'https://test.invalid', runScripts: 'dangerously' },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    posts = [],
    notices = [];
  let release,
    refresh = 0;
  Object.assign(w, {
    $: (s) => w.document.querySelector(s),
    financeCents: (v) => Number(v) * 100,
    legalDate: () => {},
    toast: (s) => notices.push(s),
  });
  w.eval(fs.readFileSync('outputs/icrapro/workspace-cash-records.js', 'utf8'));
  const form = w.document.querySelector('form'),
    dialog = w.document.querySelector('dialog');
  dialog.close = () => (dialog.open = false);
  w.fetch = async (u, o) => {
    assert.equal(u, '/api/cash-entry');
    posts.push(JSON.parse(o.body));
    if (posts.length === 1) throw Error('Network failed');
    return new Promise(
      (r) =>
        (release = () => r({ ok: true, json: async () => ({ accountBalances: { a: '1000', b: '1000' } }) })),
    );
  };
  w.bindRecordCashSubmit(form, { dialog, onSaved: () => refresh++ });
  const event = { preventDefault() {} };
  await form.onsubmit(event);
  assert.equal(dialog.open, true);
  assert.match(notices[0], /Network/);
  const retry = form.onsubmit(event);
  await form.onsubmit(event);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, posts[1].id);
  assert.equal(posts[1].amount, 1000);
  w.document.querySelector('#content').innerHTML = '<p>Another screen</p>';
  release();
  await retry;
  assert.equal(refresh, 0);
  assert.equal(dialog.open, false);
  assert.equal(w.hanAccountBalances.b, '1000');
});

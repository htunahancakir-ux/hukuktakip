const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { JSDOM } = require('jsdom');
test('Activity UI uses page cursors and ignores old replies after another view opens', async (t) => {
  const dom = new JSDOM('<div id="content"></div>', {
    url: 'https://test.invalid',
    runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    requests = [];
  w.hanRecordsEnabled = true;
  w.hanWorkspaceComplete = false;
  w.eval(fs.readFileSync('outputs/icrapro/workspace-record-list.js', 'utf8'));
  for (const page of ['messages', 'reminders']) {
    w.page = page;
    assert.equal(w.recordPageNeedsCompatibility(), false, page + ' must not load the full workspace');
  }
  let release;
  Object.assign(w, {
    AbortController,
    $: (s) => w.document.querySelector(s),
    messageOffset: 0,
    workOrderOffset: 0,
    reminderListOffset: 0,
    messageBox: 'inbox',
    workOrderScope: 'mine',
    workOrderStatus: 'pending',
    reminderListStatus: 'open',
    esc: String,
  });
  for (const f of ['messagesPage', 'workOrdersPage', 'scheduledRemindersPage'])
    w[f] = (r) => {
      w.document.querySelector('#content').innerHTML = '<section><p>' + r.total + '</p></section>';
    };
  w.recordReportFetch = async (url) => {
    requests.push(url);
    if (url.includes('box=sent')) return new Promise((r) => (release = () => r({ total: 999 })));
    return { total: 123, next: 'cursor-' + requests.length, items: [{}] };
  };
  w.eval(fs.readFileSync('outputs/icrapro/workspace-activity-records.js', 'utf8'));
  await w.loadRecordActivity('messages');
  w.messageOffset = 50;
  await w.loadRecordActivity('messages');
  assert.match(requests[1], /after=cursor-1/);
  assert.equal(w.document.querySelector('#content p').textContent, '123');
  w.messageBox = 'sent';
  w.messageOffset = 0;
  const late = w.loadRecordActivity('messages');
  await w.loadRecordActivity('orders');
  release();
  await late;
  assert.equal(w.document.querySelector('#content p').textContent, '123');
  await w.loadRecordActivity('reminders');
  w.bindReminderPagination({ total: 61, items: new Array(50), next: 'next' });
  assert.match(w.document.querySelector('.tablefoot').textContent, /1–50 \/ 61/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// Objects built inside the jsdom window have that window's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Only the backup-frequency helpers from settings.js are loaded.
const source = fs.readFileSync('outputs/icrapro/settings.js', 'utf8');
const start = source.indexOf('// Yedekleme sıklığı');
const end = source.indexOf('function backupSettingsPage');
const helpers = source.slice(start, end);

function setup(t, schedule) {
  assert.ok(start >= 0 && end > start, 'backup helpers found in settings.js');
  const dom = new JSDOM('<form id="f"></form>', { url: 'https://example.test', runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.esc = String;
  w.eval(helpers);
  const form = w.document.getElementById('f');
  form.innerHTML = w.backupScheduleFields(schedule);
  w.bindBackupSchedule(form);
  const q = (s) => form.querySelector(s);
  const times = () => [...form.querySelectorAll('[name="backupTime"]')];
  const removes = () => [...form.querySelectorAll('[data-backup-remove-time]')];
  const choose = (value) => {
    form.elements.frequency.value = value;
    form.elements.frequency.dispatchEvent(new w.Event('change'));
  };
  return { w, form, q, times, removes, choose };
}

test('daily schedule shows its times, adds and removes them, and reads back', (t) => {
  const { w, form, q, times, removes } = setup(t, { type: 'daily', times: ['09:00', '18:00'] });
  assert.equal(form.elements.frequency.value, 'daily');
  assert.deepEqual(times().map((i) => i.value), ['09:00', '18:00']);
  assert.equal(q('[data-backup-daily]').hidden, false);
  assert.equal(q('[data-backup-weekly]').hidden, true);
  assert.ok(removes().every((b) => !b.hidden));
  q('[data-backup-add-time]').click();
  assert.equal(times().length, 3);
  assert.deepEqual(
    plain(w.readBackupSchedule(form)),
    { type: 'daily', times: ['09:00', '18:00', '19:00'] },
    'the added time is one hour after the last one, never a duplicate',
  );
  for (let i = 0; i < 3; i++) q('[data-backup-add-time]').click();
  assert.equal(times().length, 6);
  assert.equal(q('[data-backup-add-time]').hidden, true);
  // Remove down to one; the last remaining time cannot be removed.
  removes()[0].click();
  assert.equal(times().length, 5);
  assert.equal(q('[data-backup-add-time]').hidden, false);
  while (removes().length > 1) removes()[0].click();
  assert.equal(times().length, 1);
  assert.equal(removes()[0].hidden, true);
  assert.equal(plain(w.readBackupSchedule(form)).type, 'daily');
});

test('weekly hides and disables the times and shows the weekday; monthly reads as 30-day interval', (t) => {
  const { w, form, q, times, choose } = setup(t, { type: 'daily', times: ['09:00', '18:00'] });
  choose('weekly');
  assert.equal(q('[data-backup-daily]').hidden, true);
  assert.equal(q('[data-backup-weekly]').hidden, false);
  assert.ok(times().every((i) => i.disabled));
  form.elements.weekday.value = '3';
  assert.deepEqual(plain(w.readBackupSchedule(form)), { type: 'weekly', weekday: 3 });
  choose('monthly');
  assert.equal(q('[data-backup-daily]').hidden, true);
  assert.equal(q('[data-backup-weekly]').hidden, true);
  assert.deepEqual(plain(w.readBackupSchedule(form)), { type: 'interval', days: 30 });
  choose('daily');
  assert.ok(times().every((i) => !i.disabled));
  assert.deepEqual(plain(w.readBackupSchedule(form)), { type: 'daily', times: ['09:00', '18:00'] });
});

test('saved weekly and interval schedules preselect the right controls', (t) => {
  const weekly = setup(t, { type: 'weekly', weekday: 5 });
  assert.equal(weekly.form.elements.frequency.value, 'weekly');
  assert.equal(weekly.form.elements.weekday.value, '5');
  assert.equal(weekly.q('[data-backup-weekly]').hidden, false);
  assert.deepEqual(plain(weekly.w.readBackupSchedule(weekly.form)), { type: 'weekly', weekday: 5 });
  const monthly = setup(t, { type: 'interval', days: 30 });
  assert.equal(monthly.form.elements.frequency.value, 'monthly');
  const legacyWeekly = setup(t, { type: 'interval', days: 7 });
  assert.equal(legacyWeekly.form.elements.frequency.value, 'weekly');
  const legacyDaily = setup(t, { type: 'interval', days: 1 });
  assert.equal(legacyDaily.form.elements.frequency.value, 'daily');
  assert.deepEqual(legacyDaily.times().map((i) => i.value), ['03:00']);
});

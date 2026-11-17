const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Until 2026-11-17 the retired Vercel deployment kept running beside the own server: its nightly
// cron backed up the old Supabase database into the same R2 folder as the live backups (the
// newest file every day was the stale one), and it still accepted sign-ins.
test('the Vercel deployment schedules nothing and sends every request to the own server', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  assert.equal(config.crons, undefined, 'no scheduled jobs on Vercel');
  assert.equal(config.rewrites, undefined);
  assert.deepEqual(config.redirects, [
    { source: '/:path*', destination: 'https://www.hanhukuktakip.com/:path*', permanent: false },
  ]);
});

test('the Vercel function answers 410 without loading the application or a database', () => {
  const file = path.join(__dirname, '../api/index.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /require\(/, 'nothing that could open the old database is loaded');
  const handler = require(file);
  const headers = {};
  const res = {
    setHeader: (k, v) => (headers[k.toLowerCase()] = v),
    end(body) {
      this.body = body;
    },
  };
  handler({ url: '/api/backups/cron', headers: {} }, res);
  assert.equal(res.statusCode, 410);
  assert.match(JSON.parse(res.body).error, /www\.hanhukuktakip\.com/);
  assert.equal(headers['cache-control'], 'no-store');
});

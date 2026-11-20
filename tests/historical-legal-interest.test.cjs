const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');
const { calculateLegalInterest } = require('../outputs/icrapro/legal-charges.cjs');
test('Historical legal interest splits at May 2005 and January 2006 without changing the original due date', () => {
  const principal = 3650000;
  assert.equal(calculateLegalInterest(principal, '2004-12-10', '2004-12-11').amount, 3800);
  const boundary = calculateLegalInterest(principal, '2005-04-30', '2005-05-02');
  assert.equal(boundary.amount, 5000);
  assert.deepEqual(
    boundary.rows.map((r) => [r.rate, r.days]),
    [
      [38, 1],
      [12, 1],
    ],
  );
  assert.equal(calculateLegalInterest(principal, '2005-01-01', '2006-01-01').amount, 750000);
  assert.equal(calculateLegalInterest(principal, '2006-01-01', '2007-01-01').amount, 328500);
  assert.throws(() => calculateLegalInterest(principal, '2004-06-30', '2006-01-01'), /doğrulanmış/);
});
test('Browser and server calculate the same rounded interest across all historical and existing rate boundaries', (t) => {
  const dom = new JSDOM('', { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const dashboard = fs.readFileSync('outputs/icrapro/dashboard.js', 'utf8');
  for (const node of parsers.babel.parse(dashboard).program.body)
    if (
      node.type === 'VariableDeclaration' &&
      node.declarations.some((d) =>
        ['legalRatePeriods', 'legalCalculationSupportedThrough'].includes(d.id.name),
      )
    )
      w.eval(dashboard.slice(node.start, node.end).replace(/^const /, 'var '));
  const operations = fs.readFileSync('outputs/icrapro/finance-operations.js', 'utf8');
  for (const node of parsers.babel.parse(operations).program.body)
    if (node.type === 'FunctionDeclaration' && ['legalDate', 'calculateLegalInterest'].includes(node.id.name))
      w.eval(operations.slice(node.start, node.end));
  for (const start of [
    '2004-12-10',
    '2005-03-16',
    '2005-07-04',
    '2006-01-01',
    '2015-12-07',
    '2024-06-01',
    '2026-07-31',
  ]) {
    const expected = calculateLegalInterest(1234567, start, '2026-11-20');
    const browser = w.calculateLegalInterest(1234567, start, '2026-11-20');
    assert.equal(browser.amount, expected.amount, start);
    assert.deepEqual(JSON.parse(JSON.stringify(browser.rows)), expected.rows, start);
  }
});

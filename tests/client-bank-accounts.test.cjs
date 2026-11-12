const { test } = require('node:test');
const assert = require('node:assert/strict');
const banks = require('../outputs/icrapro/client-bank-accounts.js');

test('Client accounts retain the existing primary bank and allow at most two additional banks', () => {
  assert.deepEqual(banks.additional({ bankName: 'Eski banka' }), []);
  assert.deepEqual(banks.additional({ additionalBankAccounts: [{}] }), []);
  assert.deepEqual(
    banks.additional({
      additionalBankAccounts: [{ bankName: ' Banka 2 ' }, { bankName: 'Banka 3', accountHolder: ' Firma ' }],
    }),
    [
      { bankName: 'Banka 2', bankBranch: '', accountHolder: '', iban: '' },
      { bankName: 'Banka 3', bankBranch: '', accountHolder: 'Firma', iban: '' },
    ],
  );
  assert.throws(() => banks.additional({ additionalBankAccounts: [{}, {}, {}] }), /en fazla 3/);
  assert.throws(() => banks.additional({ additionalBankAccounts: {} }), /en fazla 3/);
});

test('Additional IBANs are optional, normalized and validated; duplicates cannot be saved', () => {
  const iban = 'TR330006100519786457841326';
  assert.equal(banks.validIban(iban), true);
  assert.equal(banks.validIban(''), true);
  assert.equal(banks.validIban(iban.slice(0, -1) + '0'), false);
  assert.equal(
    banks.additional({ additionalBankAccounts: [{ iban: 'tr33 0006 1005 1978 6457 8413 26' }] })[0].iban,
    iban,
  );
  assert.throws(() => banks.additional({ iban, additionalBankAccounts: [{ iban }] }), /Aynı IBAN/);
  assert.throws(() => banks.additional({ additionalBankAccounts: [{ iban }, { iban }] }), /Aynı IBAN/);
  assert.throws(() => banks.additional({ additionalBankAccounts: [{ iban: 'TR123' }] }), /geçerli/);
  assert.throws(
    () => banks.additional({ additionalBankAccounts: [{ bankName: { bad: true } }] }),
    /Geçersiz/,
  );
});

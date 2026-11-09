const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPin, checkPin, MAX_ATTEMPTS, LOCK_MS } = require('../lib/ceo-pin.cjs');
const { issueProof, proofValid } = require('../lib/ceo-pin.cjs');
const crypto = require('node:crypto');

test('PIN hashlenir, beş hatalı denemede kilitlenir ve süre sonunda tekrar doğrulanabilir', async () => {
  const pin = '2580';
  let record = await createPin(pin);
  assert.notEqual(record.hash, pin);
  assert.equal((await checkPin(pin, record, 100)).ok, true);
  for (let i = 0; i < MAX_ATTEMPTS; i++) record = (await checkPin('0000', record, 100)).record;
  assert.equal((await checkPin(pin, record, 100)).ok, false);
  assert.equal((await checkPin(pin, record, 100 + LOCK_MS)).ok, true);
  await assert.rejects(createPin('12a4'));
  assert.equal((await checkPin('----', await createPin(pin), 100)).ok, false);
});
test('PIN kanıtı yalnızca aynı oturum ve bölümde geçerlidir ve süresi dolar', () => {
  const record = { proofKey: crypto.randomBytes(32).toString('hex') };
  const proof = issueProof(record, 'session-a', 'delete', 1000);
  assert.equal(proofValid(record, proof, 'session-a', 'delete', 1001), true);
  assert.equal(proofValid(record, proof, 'session-b', 'delete', 1001), false);
  assert.equal(proofValid(record, proof, 'session-a', 'permissions', 1001), false);
  assert.equal(proofValid(record, proof, 'session-a', 'delete', 61000), false);
});

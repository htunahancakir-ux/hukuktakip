const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { database } = require('./support/postgres.cjs');
const { borrowerPhoneSlots } = require('../outputs/icrapro/phone-format.js');

const MIGRATION = fs.readFileSync('supabase/migrations/20261112150000_borrower_phone_slots.sql', 'utf8');

test('borrowerPhoneSlots fills Tel-1 and Tel-2 before Tel-3 and drops repeats', () => {
  assert.deepEqual(
    borrowerPhoneSlots({
      phone1: '0 (532) 000 00 01',
      additionalPhones: ['905320000001', '05320000002', '05320000003'],
    }),
    { phone1: '0 (532) 000 00 01', phone2: '05320000002', additionalPhones: ['05320000003'] },
  );
  assert.deepEqual(borrowerPhoneSlots({ phone1: '', phone2: '', additionalPhones: [' 05320000004 '] }), {
    phone1: '05320000004',
    phone2: '',
    additionalPhones: [],
  });
});

test('migration moves numbers added from the call panel into the empty Tel-1 / Tel-2 in order', async () => {
  const { pg, pool } = await database();
  try {
    const docs = {
      // Tel-2 empty: first extra moves up, the repeat of Tel-1 is dropped, the rest follow as Tel-3…
      a: {
        phone1: '0 (532) 000 00 01',
        phone2: '',
        additionalPhones: ['905320000001', '05320000002', '05320000003'],
      },
      // Nothing to fill: left untouched.
      b: { phone1: '05320000010', phone2: '05320000011', additionalPhones: ['05320000012'] },
      // Reference numbers stay where they are.
      c: { phone1: '05320000020', referencePhone1: '05320000099', additionalPhones: ['05320000021'] },
      d: { phone1: '05320000030' },
    };
    let ordinal = 0;
    for (const [id, body] of Object.entries(docs))
      await pool.query('INSERT INTO han_data.documents(id, body, ordinal) VALUES ($1, $2::jsonb, $3)', [
        id,
        JSON.stringify({ id, debtor: 'Borçlu ' + id, ...body }),
        ++ordinal,
      ]);
    await pg.exec(MIGRATION);
    const { rows } = await pool.query('SELECT id, body, revision FROM han_data.documents ORDER BY id');
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by.a.body.phone1, '0 (532) 000 00 01');
    assert.equal(by.a.body.phone2, '05320000002');
    assert.deepEqual(by.a.body.additionalPhones, ['05320000003']);
    assert.equal(Number(by.a.revision), 2);
    assert.deepEqual(by.b.body, { id: 'b', debtor: 'Borçlu b', ...docs.b });
    assert.equal(Number(by.b.revision), 1);
    assert.equal(by.c.body.phone2, '05320000021');
    assert.deepEqual(by.c.body.additionalPhones, []);
    assert.equal(by.c.body.referencePhone1, '05320000099');
    assert.equal(Number(by.d.revision), 1);
    // Same answer as the browser helper.
    const same = borrowerPhoneSlots(docs.a);
    assert.deepEqual(
      [by.a.body.phone1, by.a.body.phone2, by.a.body.additionalPhones],
      [same.phone1, same.phone2, same.additionalPhones],
    );
  } finally {
    await pg.close();
  }
});

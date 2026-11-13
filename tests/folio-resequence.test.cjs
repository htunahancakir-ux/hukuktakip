const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, fixture } = require('./support/postgres.cjs');
const { importState } = require('../lib/postgres-store.cjs');
const { importRecords, activateRecords } = require('../lib/record-store/storage.cjs');
const { renumberFolios, nextFolioNumber } = require('../lib/record-store/folio-numbers.cjs');

test('V2 resequences active then archived files atomically, preserves money/history and enforces numeric uniqueness', async () => {
  const { pg, pool } = await database();
  try {
    const state = fixture();
    state.folioNumberingVersion = 1;
    state.data['icrapro-v1'].clients = [{ id: 'client', name: 'Client' }];
    state.data['icrapro-v1'].docs = [
      { id: 'first', number: '3', client: 'client', amount: 100, icramatikFolioNumber: 'İCRA-99' },
      { id: 'second', number: '1', client: 'client', amount: 200, previousFolioNumbers: ['S-0002'] },
    ];
    state.deletedDocuments = [
      { id: 'archive', document: { id: 'deleted', number: '2', client: 'client', amount: 300 } },
    ];
    state.data['hanhukuk-accounting-v1'] = {
      accounts: [{ id: 'cash', name: 'Cash' }],
      entries: [{ id: 'entry', amount: 1500, accountId: 'cash', type: 'income', date: '2026-11-01' }],
    };
    state.data['hanhukuk-finance-v1'] = [
      {
        id: 'payment',
        documentId: 'first',
        type: 'payment',
        amount: 1500,
        date: '2026-11-01',
        accountId: 'cash',
      },
    ];
    await importState(pool, state);
    await importRecords(pool);
    await activateRecords(pool);
    const other = await require('../lib/saas/tenants.cjs').createTenant(pool, {
      slug: 'other-folios',
      name: 'Other Office',
      ownerUserId: 'other-owner',
    });
    await pool.query('INSERT INTO han_data.clients(tenant_id,id,body,ordinal) VALUES($1,$2,$3,0)', [
      other.id,
      'client',
      JSON.stringify({ id: 'client', name: 'Other Client' }),
    ]);
    await pool.query('INSERT INTO han_data.documents(tenant_id,id,body,ordinal) VALUES($1,$2,$3,0)', [
      other.id,
      'foreign',
      JSON.stringify({ id: 'foreign', number: '999', client: 'client', amount: 900 }),
    ]);
    await pool.query('INSERT INTO han_data.metadata(tenant_id,id,body) VALUES($1,1,$2)', [
      other.id,
      JSON.stringify({ folioNumberingVersion: 1 }),
    ]);
    const foreignBefore = (
      await pool.query('SELECT body FROM han_data.documents WHERE tenant_id=$1', [other.id])
    ).rows;
    const finance = (await pool.query('SELECT * FROM han_data.financial_events')).rows;
    const accounting = (await pool.query('SELECT * FROM han_data.ledger_entries')).rows;
    const before = (
      await pool.query(
        'SELECT id,body FROM han_data.documents WHERE tenant_id=han_private.current_tenant() ORDER BY id',
      )
    ).rows;
    const preview = await renumberFolios(pool, { version: 2, dryRun: true });
    assert.deepEqual(
      preview.mapping.map((m) => [m.id, m.number]),
      [
        ['first', '1'],
        ['second', '2'],
        ['deleted', '3'],
      ],
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT id,body FROM han_data.documents WHERE tenant_id=han_private.current_tenant() ORDER BY id',
        )
      ).rows,
      before,
    );
    await renumberFolios(pool, { version: 2 });
    assert.deepEqual(
      (await pool.query('SELECT body FROM han_data.documents WHERE tenant_id=$1', [other.id])).rows,
      foreignBefore,
    );
    const rows = (
      await pool.query(
        'SELECT id,body FROM han_data.documents WHERE tenant_id=han_private.current_tenant() ORDER BY id',
      )
    ).rows;
    for (const row of rows) {
      const original = structuredClone(before.find((r) => r.id === row.id).body);
      const actual = structuredClone(row.body);
      delete original.number;
      delete original.previousFolioNumbers;
      delete actual.number;
      delete actual.previousFolioNumbers;
      assert.deepEqual(actual, original);
    }
    assert(rows.find((r) => r.id === 'second').body.previousFolioNumbers.includes('S-0002'));
    assert(rows.find((r) => r.id === 'second').body.previousFolioNumbers.includes('1'));
    assert.equal(
      (await pool.query('SELECT body FROM han_data.document_archives')).rows[0].body.document.number,
      '3',
    );
    assert.deepEqual((await pool.query('SELECT * FROM han_data.financial_events')).rows, finance);
    assert.deepEqual((await pool.query('SELECT * FROM han_data.ledger_entries')).rows, accounting);
    for (const number of ['1', '01', '3']) {
      await assert.rejects(
        pool.query(
          "UPDATE han_data.documents SET body=jsonb_set(body,'{number}',$1::jsonb) WHERE id='second'",
          [JSON.stringify(number)],
        ),
        (e) => e.code === '23505' && e.constraint === 'documents_tenant_numeric_number_unique',
      );
    }
    assert.deepEqual(await Promise.all([nextFolioNumber(pool), nextFolioNumber(pool)]), ['4', '5']);
    assert.equal((await renumberFolios(pool, { version: 2 })).alreadyApplied, true);
    assert.equal((await renumberFolios(pool)).alreadyApplied, true, 'old migration cannot run after v2');
    const audit = (
      await pool.query('SELECT body FROM han_data.metadata WHERE tenant_id=han_private.current_tenant()')
    ).rows[0].body;
    assert.equal(audit.folioRenumberingV2.mapping.length, 3);
    assert.equal(audit.folioNumberingVersion, 2);
    // Another office may reuse 1; its counter and files remain independent.
    await pool.query("SELECT set_config('han.tenant_id',$1,false)", [other.id]);
    await renumberFolios(pool, { version: 2 });
    assert.equal(
      (await pool.query('SELECT number FROM han_data.documents WHERE tenant_id=han_private.current_tenant()'))
        .rows[0].number,
      '1',
    );
    assert.equal(await nextFolioNumber(pool), '2');
    await pool.query("SELECT set_config('han.tenant_id','',false)");
    assert.deepEqual(
      (
        await pool.query(
          'SELECT id,body FROM han_data.documents WHERE tenant_id=han_private.current_tenant() ORDER BY id',
        )
      ).rows,
      rows,
    );
    assert.equal(await nextFolioNumber(pool), '6');
  } finally {
    await pg.close();
  }
});

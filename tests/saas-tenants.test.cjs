const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./support/postgres.cjs');
const { createTenant, requireTenantAccess } = require('../lib/saas/tenants.cjs');
const forbidden = (error) => error.status === 403;

test('SaaS tenant lifecycle and access boundaries', async (t) => {
  const { pg, pool } = await database();
  try {
    const one = await createTenant(pool, { slug: 'office-one', name: 'Birinci Büro', ownerUserId: 'alice' });
    const two = await createTenant(pool, { slug: 'office-two', name: 'İkinci Büro', ownerUserId: 'bob' });
    const access = (slug, userId) => requireTenantAccess(pool, { slug, userId });

    await t.test('new offices stay unavailable until data isolation is ready', async () => {
      assert.equal(one.status, 'provisioning');
      await assert.rejects(access(one.slug, 'alice'), forbidden);
      const { rows } = await pool.query(
        `SELECT plan_code, seat_limit, access_until > CURRENT_TIMESTAMP AS future
         FROM han_saas.subscriptions WHERE tenant_id = $1`,
        [one.id],
      );
      assert.deepEqual(rows[0], { plan_code: 'trial', seat_limit: 3, future: true });
    });
    await pool.query("UPDATE han_saas.tenants SET status = 'enabled'");

    await t.test('membership cannot cross office boundaries, including supplied roles', async () => {
      assert.equal((await access(one.slug, 'alice')).role, 'owner');
      assert.equal((await access(two.slug, 'bob')).id, two.id);
      await assert.rejects(access(two.slug, 'alice'), forbidden);
      await assert.rejects(
        requireTenantAccess(pool, {
          slug: one.slug,
          userId: 'mallory',
          role: 'owner',
          tenantId: one.id,
        }),
        forbidden,
      );
      await assert.rejects(access('missing-office', 'alice'), forbidden);
      await assert.rejects(access("office-one' OR true--", 'alice'), forbidden);
    });

    await t.test('revocation, suspension and subscription expiry deny access', async () => {
      await pool.query("UPDATE han_saas.memberships SET status = 'revoked' WHERE tenant_id=$1", [one.id]);
      await assert.rejects(access(one.slug, 'alice'), forbidden);
      await pool.query("UPDATE han_saas.memberships SET status = 'active' WHERE tenant_id=$1", [one.id]);
      await pool.query("UPDATE han_saas.tenants SET status = 'suspended' WHERE id=$1", [one.id]);
      await assert.rejects(access(one.slug, 'alice'), forbidden);
      await pool.query("UPDATE han_saas.tenants SET status = 'enabled' WHERE id=$1", [one.id]);
      for (const status of ['past_due', 'canceled']) {
        await pool.query('UPDATE han_saas.subscriptions SET status=$2 WHERE tenant_id=$1', [one.id, status]);
        await assert.rejects(access(one.slug, 'alice'), forbidden);
      }
      await pool.query(
        `UPDATE han_saas.subscriptions SET status='trialing',
        access_until=CURRENT_TIMESTAMP - interval '1 second' WHERE tenant_id=$1`,
        [one.id],
      );
      await assert.rejects(access(one.slug, 'alice'), forbidden);
    });

    await t.test('duplicate and invalid office codes do not create partial records', async () => {
      await assert.rejects(
        createTenant(pool, {
          slug: one.slug,
          name: 'Duplicate',
          ownerUserId: 'other',
        }),
        (e) => e.status === 409,
      );
      for (const slug of ['api', 'Uppercase', '-office', 'ab', 'a'.repeat(64)]) {
        await assert.rejects(
          createTenant(pool, { slug, name: 'Invalid', ownerUserId: 'alice' }),
          (e) => e.status === 400,
        );
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_saas.tenants')).rows[0].n, 3);
    });

    await t.test('a provisioning failure rolls back tenant and owner together', async () => {
      await pool.query(
        `ALTER TABLE han_saas.subscriptions ADD CONSTRAINT test_failure CHECK (seat_limit > 3) NOT VALID`,
      );
      await assert.rejects(
        createTenant(pool, {
          slug: 'failed-office',
          name: 'Failed Office',
          ownerUserId: 'charlie',
        }),
        (e) => e.code === '23514',
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM han_saas.tenants WHERE slug='failed-office'"))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM han_saas.memberships WHERE user_id='charlie'"))
          .rows[0].n,
        0,
      );
      await pool.query('ALTER TABLE han_saas.subscriptions DROP CONSTRAINT test_failure');
    });

    await t.test('unprivileged database role cannot read the control plane', async () => {
      await pool.query('CREATE ROLE saas_test_reader');
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SET LOCAL ROLE saas_test_reader');
        await assert.rejects(db.query('SELECT * FROM han_saas.tenants'), (e) => e.code === '42501');
      } finally {
        await db.query('ROLLBACK');
        db.release();
      }
      const { rows } = await pool.query(`SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'han_saas'::regnamespace AND relkind = 'r'`);
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.relrowsecurity));
    });
  } finally {
    await pg.close();
  }
});

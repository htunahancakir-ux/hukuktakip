const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, serve } = require('./support/postgres.cjs');
const { provisionOffice } = require('../lib/saas/tenants.cjs');
const {
  createInvitation,
  revokeInvitation,
  listInvitations,
  acceptInvitation,
} = require('../lib/saas/invitations.cjs');
const { createTenantPool } = require('../lib/saas/tenant-pool.cjs');
const { createStore } = require('../lib/postgres-store.cjs');
const { createApplication } = require('../lib/application.cjs');

const status = (code) => (error) => error.status === code;
const secret = 'Synthetic-Onboarding-Test-Only';
const joiner = (extra) => ({ name: 'Yeni Kişi', password: secret, ...extra });

async function login(server, username, password = secret) {
  const response = await fetch(server.url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Han-Request': '1' },
    body: JSON.stringify({ username, password }),
  });
  return { status: response.status, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
}

test('office provisioning and invitations', async (t) => {
  const { pg, pool } = await database();
  const servers = [];
  try {
    const one = await provisionOffice(pool, {
      slug: 'office-one',
      name: 'Birinci Büro',
      admin: { name: 'Ada Yönetici', username: ' Ada ', password: secret },
      userLimit: 3,
    });
    const two = await provisionOffice(pool, {
      slug: 'office-two',
      name: 'İkinci Büro',
      admin: { name: 'Bora Yönetici', username: 'ada', password: secret },
    });
    const manage = (office, userId = office.adminUserId) => ({ tenantId: office.id, invitedBy: userId });

    await t.test('provisioning builds tenant, workspace, owner and trial in one step', async () => {
      assert.equal(one.status, 'provisioning');
      const { rows } = await pool.query(
        `SELECT m.role, s.seat_limit, s.status, a.username, a.enabled,
                (st.payload->'users'->0->>'role') AS app_role
         FROM han_saas.memberships m
         JOIN han_saas.subscriptions s USING (tenant_id)
         JOIN han_private.han_state st ON st.tenant_id = m.tenant_id
         JOIN han_private.han_account_index a ON a.tenant_id = m.tenant_id AND a.id = m.user_id
         WHERE m.tenant_id = $1`,
        [one.id],
      );
      assert.deepEqual(rows, [
        { role: 'owner', seat_limit: 3, status: 'trialing', username: 'ada', enabled: true, app_role: 'ceo' },
      ]);
      // Same username in two offices is fine, and the default limit is the trial value.
      assert.equal(
        (await pool.query('SELECT seat_limit FROM han_saas.subscriptions WHERE tenant_id=$1', [two.id])).rows[0]
          .seat_limit,
        3,
      );
    });

    await t.test('invalid provisioning input is rejected and leaves nothing behind', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM han_saas.tenants')).rows[0].n;
      const base = { slug: 'office-three', name: 'Üçüncü', admin: { name: 'X', username: 'x', password: secret } };
      for (const bad of [
        { ...base, admin: { ...base.admin, password: 'short' } },
        { ...base, admin: { ...base.admin, username: '' } },
        { ...base, userLimit: 0 },
        { ...base, userLimit: 1.5 },
        { ...base, slug: 'api' },
      ])
        await assert.rejects(provisionOffice(pool, bad), status(400));
      await assert.rejects(provisionOffice(pool, { ...base, slug: 'office-one' }), status(409));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM han_saas.tenants')).rows[0].n, before);
    });

    await t.test('invitations require an enabled office and an owner or admin', async () => {
      await assert.rejects(createInvitation(pool, { ...manage(one), role: 'staff' }), status(403));
      await pool.query("UPDATE han_saas.tenants SET status = 'enabled'");
      await assert.rejects(createInvitation(pool, { ...manage(one, 'nobody'), role: 'staff' }), status(403));
      // An owner of another office has no authority here.
      await assert.rejects(createInvitation(pool, { ...manage(one, two.adminUserId), role: 'staff' }), status(403));
      await assert.rejects(createInvitation(pool, { ...manage(one), role: 'ceo' }), status(400));
      await assert.rejects(createInvitation(pool, { ...manage(one), role: 'staff', ttlHours: 0 }), status(400));
    });

    let invite;
    await t.test('the raw token is shown once and only its hash is stored', async () => {
      invite = await createInvitation(pool, { ...manage(one), role: 'staff', note: 'Muhasebe' });
      assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
      const { rows } = await pool.query('SELECT token_hash FROM han_saas.invitations WHERE id = $1', [invite.id]);
      assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/);
      assert.notEqual(rows[0].token_hash, invite.token);
      const listed = await listInvitations(pool, { tenantId: one.id, requestedBy: one.adminUserId });
      assert.equal(listed.length, 1);
      assert.ok(!JSON.stringify(listed).includes(invite.token));
    });

    await t.test('acceptance creates a working account that only exists in that office', async () => {
      const joined = await acceptInvitation(pool, { token: invite.token, ...joiner({ username: 'Deniz' }) });
      assert.equal(joined.slug, 'office-one');
      const a = createTenantPool(pool, one.id);
      const b = createTenantPool(pool, two.id);
      const sa = await serve(createApplication({ store: createStore(a) }));
      const sb = await serve(createApplication({ store: createStore(b) }));
      servers.push(sa, sb);
      const ok = await login(sa, 'deniz');
      assert.equal(ok.status, 200);
      assert.equal((await login(sb, 'deniz')).status, 401);
      assert.equal((await login(sa, 'ada')).status, 200);
      const session = await (await fetch(sa.url + '/api/session', { headers: { cookie: ok.cookie } })).json();
      assert.equal(session.user.role, 'staff');
      assert.equal(
        (
          await pool.query(
            `SELECT role FROM han_saas.memberships WHERE tenant_id = $1 AND user_id = $2`,
            [one.id, joined.userId],
          )
        ).rows[0].role,
        'member',
      );
    });

    await t.test('an invitation is single use', async () => {
      await assert.rejects(
        acceptInvitation(pool, { token: invite.token, ...joiner({ username: 'baska' }) }),
        status(404),
      );
    });

    await t.test('unknown, malformed, revoked and expired tokens look the same', async () => {
      const unknown = 'A'.repeat(43);
      const revoked = await createInvitation(pool, { ...manage(one), role: 'staff' });
      await revokeInvitation(pool, { tenantId: one.id, invitationId: revoked.id, revokedBy: one.adminUserId });
      const expired = await createInvitation(pool, { ...manage(one), role: 'staff' });
      await pool.query(
        "UPDATE han_saas.invitations SET expires_at = CURRENT_TIMESTAMP - interval '1 second' WHERE id = $1",
        [expired.id],
      );
      const messages = new Set();
      for (const token of [unknown, "x' OR 1=1--", '', revoked.token, expired.token, undefined]) {
        await assert.rejects(
          acceptInvitation(pool, { token, ...joiner({ username: 'ghost' }) }),
          (error) => (messages.add(error.message), error.status === 404),
        );
      }
      assert.equal(messages.size, 1);
      await assert.rejects(
        revokeInvitation(pool, { tenantId: one.id, invitationId: revoked.id, revokedBy: one.adminUserId }),
        status(404),
      );
      await assert.rejects(
        revokeInvitation(pool, { tenantId: two.id, invitationId: expired.id, revokedBy: two.adminUserId }),
        status(404),
      );
    });

    await t.test('a taken username or weak password does not burn the invitation', async () => {
      const fresh = await createInvitation(pool, { ...manage(one), role: 'admin' });
      await assert.rejects(acceptInvitation(pool, { token: fresh.token, ...joiner({ username: 'ADA' }) }), status(409));
      await assert.rejects(
        acceptInvitation(pool, { token: fresh.token, ...joiner({ username: 'ece', password: 'weak' }) }),
        status(400),
      );
      const joined = await acceptInvitation(pool, { token: fresh.token, ...joiner({ username: 'ece' }) });
      const { rows } = await pool.query(
        `SELECT m.role, a.body->>'role' AS app_role FROM han_saas.memberships m
         JOIN han_private.han_account_index a ON a.tenant_id = m.tenant_id AND a.id = m.user_id
         WHERE m.tenant_id = $1 AND m.user_id = $2`,
        [one.id, joined.userId],
      );
      assert.deepEqual(rows, [{ role: 'admin', app_role: 'admin' }]);
    });

    await t.test('the purchased user count is enforced, including simultaneous acceptances', async () => {
      // Office one now has 3 of 3 users.
      const blocked = await createInvitation(pool, { ...manage(one), role: 'staff' });
      await assert.rejects(
        acceptInvitation(pool, { token: blocked.token, ...joiner({ username: 'fazla' }) }),
        status(409),
      );
      await pool.query('UPDATE han_saas.subscriptions SET seat_limit = 4 WHERE tenant_id = $1', [one.id]);
      const second = await createInvitation(pool, { ...manage(one), role: 'staff' });
      const results = await Promise.allSettled([
        acceptInvitation(pool, { token: blocked.token, ...joiner({ username: 'yarisci-a' }) }),
        acceptInvitation(pool, { token: second.token, ...joiner({ username: 'yarisci-b' }) }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM han_saas.memberships WHERE tenant_id = $1", [one.id])).rows[0].n,
        4,
      );
      const { rows } = await pool.query(
        "SELECT jsonb_array_length(payload->'users') AS n FROM han_private.han_state WHERE tenant_id = $1",
        [one.id],
      );
      assert.equal(rows[0].n, 4);
    });

    await t.test('suspended offices and active record stores refuse new accounts', async () => {
      const invite2 = await createInvitation(pool, { ...manage(two), role: 'staff' });
      await pool.query("UPDATE han_saas.tenants SET status = 'suspended' WHERE id = $1", [two.id]);
      await assert.rejects(
        acceptInvitation(pool, { token: invite2.token, ...joiner({ username: 'gecici' }) }),
        status(404),
      );
      await pool.query("UPDATE han_saas.tenants SET status = 'enabled' WHERE id = $1", [two.id]);
      await pool.query(
        `INSERT INTO han_data.control(id, mode, source_revision, source_digest, tenant_id)
         VALUES (1, 'active', 1, 'synthetic', $1)`,
        [two.id],
      );
      await assert.rejects(
        acceptInvitation(pool, { token: invite2.token, ...joiner({ username: 'gecici' }) }),
        status(409),
      );
      const { rows } = await pool.query(
        "SELECT accepted_at FROM han_saas.invitations WHERE id = $1",
        [invite2.id],
      );
      assert.equal(rows[0].accepted_at, null);
    });
  } finally {
    for (const server of servers) await server.close();
    await pg.close();
  }
});

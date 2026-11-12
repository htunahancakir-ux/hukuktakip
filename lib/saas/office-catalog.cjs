const { randomUUID } = require('node:crypto');
const { inTransaction } = require('../db-transaction.cjs');
const { LEGACY_TENANT_ID } = require('./tenant-pool.cjs');

// The office-facing side of the product catalog: the announcement card on the home page,
// the "Modüller" page (what the office has, what it can buy, campaign prices) and the
// "Talep et" / "İlgileniyorum" requests that land in the sales pipeline. Everything is scoped
// to the one office this server serves. The existing office on the root domain was never sold
// add-ons, so it gets no announcements and no catalog.

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{1,40}$/;
const ACTIONS = ['click', 'dismiss', 'interest'];
const MANAGERS = ['ceo', 'admin'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (value) => Number(value ?? 0);

// Campaign terms the office may see (never usage counts or other offices).
const campaignView = (c) =>
  !c
    ? null
    : {
        name: c.name,
        discountType: c.discount_type,
        discountValue: num(c.discount_value),
        applies: c.applies,
        couponCode: c.coupon_code,
        endsAt: c.ends_at,
      };

function createOfficeCatalog(pool, { tenantId }) {
  const legacy = tenantId === LEGACY_TENANT_ID;
  const label = (user) => String(user?.name || user?.username || 'Büro kullanıcısı').slice(0, 160);
  const userKey = (user) => String(user?.id || user?.username || '').slice(0, 100);

  // Live campaigns this office could use for a product right now.
  async function campaignsFor(db, code, owned) {
    const { rows } = await db.query(
      `SELECT c.* FROM han_saas.campaigns c
       WHERE c.status = 'active' AND c.starts_at <= CURRENT_TIMESTAMP AND c.ends_at > CURRENT_TIMESTAMP
         AND (c.max_uses IS NULL OR c.used_count < c.max_uses)
         AND (cardinality(c.product_codes) = 0 OR $2 = ANY(c.product_codes))
         AND c.audience <> 'new_offices'
         AND (c.audience <> 'selected' OR $1 = ANY(c.tenant_ids))
         AND NOT EXISTS (SELECT 1 FROM han_saas.campaign_redemptions r WHERE r.campaign_id = c.id AND r.tenant_id = $1)
       ORDER BY c.ends_at`,
      [tenantId, code],
    );
    return rows.filter(
      (c) =>
        (c.audience !== 'without_product' || owned?.status !== 'active') &&
        (c.audience !== 'trialing' || owned?.status === 'trial'),
    );
  }

  async function openRequest(db, code) {
    const { rows } = await db.query(
      `SELECT id FROM han_saas.prospects WHERE kind = 'upsell' AND tenant_id = $1 AND product_codes[1] = $2
         AND stage NOT IN ('won', 'lost') AND source IN ('announcement', 'request')`,
      [tenantId, code],
    );
    return rows[0]?.id ?? null;
  }

  // Opens an upsell in the sales pipeline, once per product while it is open. Callers hold the
  // office row lock, so two requests for the same product cannot both pass the check.
  async function request(db, user, { code, source, note, monthlyKurus, officeName }) {
    if (await openRequest(db, code)) return { requested: true, already: true };
    await db.query(
      `INSERT INTO han_saas.prospects(id, kind, tenant_id, office_name, contact_name, source, product_codes,
         expected_monthly_kurus, note, created_label, next_action_at)
       VALUES ($1, 'upsell', $2, $3, $4, $5, ARRAY[$6]::text[], $7, $8, $4, CURRENT_TIMESTAMP)`,
      [randomUUID(), tenantId, officeName, label(user), source, code, monthlyKurus, note],
    );
    return { requested: true, already: false };
  }

  return {
    // The one card to show this person on the home page, or null.
    async news(user) {
      if (legacy) return { card: null };
      const manager = MANAGERS.includes(user?.role);
      return inTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `SELECT a.*, m.name AS product_name, m.kind AS product_kind, m.status AS product_status,
                  m.monthly_price_kurus::text AS product_price, m.pack_quantity, m.pack_unit, m.features,
                  tm.status AS owned_status
           FROM han_saas.announcements a
           LEFT JOIN han_saas.modules m ON m.code = a.product_code
           LEFT JOIN han_saas.tenant_modules tm ON tm.tenant_id = $1 AND tm.module_code = a.product_code
           WHERE a.status = 'published' AND a.starts_at <= CURRENT_TIMESTAMP AND a.ends_at > CURRENT_TIMESTAMP
             AND (a.roles = 'everyone' OR $3)
             AND (a.audience = 'all'
               OR (a.audience = 'selected' AND $1 = ANY(a.tenant_ids))
               OR (a.audience = 'without_product' AND coalesce(tm.status, 'removed') NOT IN ('active', 'trial'))
               OR (a.audience = 'trialing' AND tm.status = 'trial'))
             AND NOT EXISTS (SELECT 1 FROM han_saas.announcement_views v WHERE v.announcement_id = a.id
               AND v.tenant_id = $1 AND v.user_id = $2 AND v.dismissed_at IS NOT NULL)
           ORDER BY a.priority DESC, a.starts_at DESC LIMIT 1`,
          [tenantId, userKey(user), manager],
        );
        if (!rows.length) return { card: null };
        const a = rows[0];
        await db.query(
          `INSERT INTO han_saas.announcement_views(announcement_id, tenant_id, user_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [a.id, tenantId, userKey(user)],
        );
        let campaign = null;
        if (a.campaign_id) {
          const { rows: c } = await db.query(
            `SELECT * FROM han_saas.campaigns WHERE id = $1 AND status = 'active'
               AND starts_at <= CURRENT_TIMESTAMP AND ends_at > CURRENT_TIMESTAMP`,
            [a.campaign_id],
          );
          campaign = campaignView(c[0]);
        }
        const { rows: seen } = await db.query(
          'SELECT interested_at FROM han_saas.announcement_views WHERE announcement_id = $1 AND tenant_id = $2 AND user_id = $3',
          [a.id, tenantId, userKey(user)],
        );
        return {
          card: {
            id: a.id,
            kind: a.kind,
            title: a.title,
            body: a.body,
            endsAt: a.ends_at,
            dismissible: a.dismissible,
            // Prices and the request button are for managers only.
            product:
              a.product_code && manager
                ? {
                    code: a.product_code,
                    name: a.product_name,
                    kind: a.product_kind,
                    available: ['selling', 'soon'].includes(a.product_status),
                    priceKurus: num(a.product_price),
                    packQuantity: a.pack_quantity,
                    packUnit: a.pack_unit,
                    owned: ['active', 'trial'].includes(a.owned_status) ? a.owned_status : null,
                  }
                : null,
            campaign: manager ? campaign : null,
            interested: !!seen[0]?.interested_at,
          },
        };
      });
    },

    // click: "İncele"; dismiss: "Kapat" (never shown again to this person); interest:
    // "İlgileniyorum" (managers only; opens a request in the sales pipeline).
    async mark(user, id, action) {
      if (legacy) throw fail(404, 'Duyuru bulunamadı.');
      if (typeof id !== 'string' || !UUID.test(id)) throw fail(404, 'Duyuru bulunamadı.');
      if (!ACTIONS.includes(action)) throw fail(400, 'İşlem geçersiz.');
      const manager = MANAGERS.includes(user?.role);
      if (action === 'interest' && !manager) throw fail(403, 'Bu işlem yöneticiler içindir.');
      return inTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `SELECT a.id, a.dismissible, a.product_code, a.roles, m.monthly_price_kurus::text AS price, m.kind, t.name AS office
           FROM han_saas.announcements a
           LEFT JOIN han_saas.modules m ON m.code = a.product_code
           JOIN han_saas.tenants t ON t.id = $2
           WHERE a.id = $1 AND a.status = 'published' AND a.starts_at <= CURRENT_TIMESTAMP AND a.ends_at > CURRENT_TIMESTAMP
             AND (a.roles = 'everyone' OR $3)
             AND (a.audience <> 'selected' OR $2 = ANY(a.tenant_ids))`,
          [id, tenantId, manager],
        );
        if (!rows.length) throw fail(404, 'Duyuru bulunamadı.');
        const a = rows[0];
        if (action === 'dismiss' && !a.dismissible) throw fail(409, 'Bu duyuru kapatılamaz.');
        if (action === 'interest' && !a.product_code)
          throw fail(400, 'Bu duyuruda talep edilecek bir ürün yok.');
        const column = { click: 'clicked_at', dismiss: 'dismissed_at', interest: 'interested_at' }[action];
        await db.query(
          `INSERT INTO han_saas.announcement_views(announcement_id, tenant_id, user_id, ${column})
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (announcement_id, tenant_id, user_id) DO UPDATE SET ${column} = coalesce(han_saas.announcement_views.${column}, CURRENT_TIMESTAMP)`,
          [id, tenantId, userKey(user)],
        );
        if (action !== 'interest') return { ok: true };
        await db.query('SELECT 1 FROM han_saas.tenants WHERE id = $1 FOR UPDATE', [tenantId]);
        return request(db, user, {
          code: a.product_code,
          source: 'announcement',
          note: 'Duyurudan "İlgileniyorum" dedi.',
          monthlyKurus: a.kind === 'module' ? num(a.price) : 0,
          officeName: a.office,
        });
      });
    },

    // The "Modüller" page: subscription, the office's modules, and what it can buy.
    async catalog() {
      if (legacy) return { legacy: true, subscription: null, owned: [], products: [] };
      return inTransaction(
        pool,
        async (db) => {
          const { rows: sub } = await db.query(
            `SELECT s.seat_limit, s.access_until, s.status,
               greatest(
                 (SELECT count(*) FROM han_saas.memberships mb WHERE mb.tenant_id = $1 AND mb.status = 'active'),
                 coalesce((SELECT count(*) FROM han_private.han_state hs
                   CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(hs.payload->'users') = 'array' THEN hs.payload->'users' ELSE '[]'::jsonb END) u
                   WHERE hs.tenant_id = $1 AND hs.id = 1 AND coalesce(u->>'active', 'true') <> 'false'
                  AND coalesce(u->>'platformSupport', 'false') <> 'true'), 0)
               )::int AS used
             FROM han_saas.subscriptions s WHERE s.tenant_id = $1`,
            [tenantId],
          );
          const { rows: ownedRows } = await db.query(
            `SELECT tm.module_code, tm.status, tm.price_kurus::text AS price, tm.trial_until, tm.added_at, m.name
             FROM han_saas.tenant_modules tm JOIN han_saas.modules m ON m.code = tm.module_code
             WHERE tm.tenant_id = $1 AND (tm.status = 'active' OR (tm.status = 'trial' AND tm.trial_until > CURRENT_TIMESTAMP))
             ORDER BY m.name`,
            [tenantId],
          );
          const owned = new Map(ownedRows.map((r) => [r.module_code, r]));
          const { rows: products } = await db.query(
            `SELECT code, name, description, kind, status, features, trial_days, pack_quantity, pack_unit,
                    monthly_price_kurus::text AS price
             FROM han_saas.modules WHERE status IN ('selling', 'soon') ORDER BY sort_order, name`,
          );
          const { rows: requests } = await db.query(
            `SELECT product_codes[1] AS code FROM han_saas.prospects
             WHERE kind = 'upsell' AND tenant_id = $1 AND stage NOT IN ('won', 'lost') AND source IN ('announcement', 'request')`,
            [tenantId],
          );
          const requested = new Set(requests.map((r) => r.code));
          const list = [];
          for (const p of products) {
            const mine = owned.get(p.code);
            if (mine?.status === 'active' && p.kind === 'module') continue;
            const offers = await campaignsFor(db, p.code, mine);
            list.push({
              code: p.code,
              name: p.name,
              description: p.description,
              kind: p.kind,
              status: p.status,
              features: p.features,
              trialDays: p.trial_days,
              packQuantity: p.pack_quantity,
              packUnit: p.pack_unit,
              priceKurus: num(p.price),
              trialUntil: mine?.status === 'trial' ? mine.trial_until : null,
              campaign: campaignView(offers[0]),
              requested: requested.has(p.code),
            });
          }
          return {
            legacy: false,
            subscription: sub.length
              ? {
                  seatLimit: sub[0].seat_limit,
                  used: sub[0].used,
                  accessUntil: sub[0].access_until,
                  status: sub[0].status,
                }
              : null,
            owned: ownedRows.map((r) => ({
              code: r.module_code,
              name: r.name,
              status: r.status,
              priceKurus: num(r.price),
              trialUntil: r.trial_until,
              since: r.added_at,
            })),
            products: list,
          };
        },
        { readOnly: true },
      );
    },

    // "Talep et" on the Modüller page.
    async requestProduct(user, input) {
      if (legacy) throw fail(404, 'Bu kurulumda modül talebi yok.');
      if (typeof input.code !== 'string' || !CODE.test(input.code)) throw fail(400, 'Ürün geçersiz.');
      const note = input.note === undefined || input.note === null ? '' : String(input.note).trim();
      if (note.length > 1000) throw fail(400, 'Not en fazla 1000 karakter olabilir.');
      return inTransaction(pool, async (db) => {
        // One request at a time per office, so the "one open request per product" rule holds.
        const { rows: office } = await db.query(
          'SELECT name FROM han_saas.tenants WHERE id = $1 FOR UPDATE',
          [tenantId],
        );
        if (!office.length) throw fail(404, 'Büro bulunamadı.');
        const { rows } = await db.query(
          `SELECT m.kind, m.monthly_price_kurus::text AS price, tm.status AS owned
           FROM han_saas.modules m
           LEFT JOIN han_saas.tenant_modules tm ON tm.tenant_id = $2 AND tm.module_code = m.code
           WHERE m.code = $1 AND m.status IN ('selling', 'soon')`,
          [input.code, tenantId],
        );
        if (!rows.length) throw fail(404, 'Ürün bulunamadı.');
        if (rows[0].kind === 'module' && rows[0].owned === 'active')
          throw fail(409, 'Bu modül büronuzda zaten açık.');
        return request(db, user, {
          code: input.code,
          source: 'request',
          note: note || null,
          monthlyKurus: rows[0].kind === 'module' ? num(rows[0].price) : 0,
          officeName: office[0].name,
        });
      });
    },
  };
}

module.exports = { createOfficeCatalog };

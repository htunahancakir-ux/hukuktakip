const terms = require('../../lib/employee-terms.cjs');

async function handleEmployeeTermsRoutes(ctx) {
  const { req, res, url, u, body, fail, send, userEnabled } = ctx;
  const route = url.pathname;
  if (!route.startsWith('/api/employee-terms/')) return false;
  if (!u) throw fail(401, 'Giriş yapın.');
  const reply = (value) => {
    send(res, 200, value);
    return true;
  };
  const document = () => terms.currentRelease(ctx.state);
  const activeUsers = () => ctx.state.users.filter(userEnabled);
  const audit = (action, version) => {
    res.hanEmployeeTermsAudit = { action, version };
  };
  const stale = () => fail(409, 'Belge değişti. Sayfayı yenileyip güncel sürümü açın.');
  const save = (change) => {
    const next = structuredClone(ctx.state);
    change(terms.data(next));
    ctx.persistEmployeeTerms(next);
  };

  if (route === '/api/employee-terms/current' && req.method === 'GET') {
    const accepted = terms.acceptance(ctx.state, u);
    return reply({
      document: document(),
      required: terms.requiresEmployeeTerms(ctx.state, u),
      reminder: terms.reminder(ctx.state, u)?.sentAt || null,
      acceptedAt: accepted?.acceptedAt || null,
      notice: terms.currentNotice(ctx.state),
    });
  }
  if (route === '/api/employee-terms/history' && req.method === 'GET') {
    const releases = ctx.state.employeeTerms?.releases || [];
    const byVersion = new Map(releases.map((doc) => [doc.version, doc]));
    const version = url.searchParams.get('version');
    const rows = (ctx.state.employeeTerms?.acceptances || [])
      .filter((row) => row.accountId === u.id && byVersion.get(row.version)?.hash === row.hash)
      .reverse();
    if (version) {
      const row = rows.find((row) => row.version === version);
      if (!row) throw fail(404, 'Bu belge için kabul kaydınız bulunamadı.');
      return reply({ record: row, document: byVersion.get(row.version) });
    }
    return reply({
      items: rows,
      notice: terms.currentNotice(ctx.state),
    });
  }
  if (route === '/api/employee-terms/records' && req.method === 'GET') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
    if (terms.requiresEmployeeTerms(ctx.state, u)) {
      send(res, 428, { error: terms.REQUIRED_MESSAGE, code: 'employee_terms_required' });
      return true;
    }
    const data = ctx.state.employeeTerms;
    const version = url.searchParams.get('version') || document()?.version;
    return reply({
      versions: (data?.releases || []).map(({ version, issuedAt }) => ({ version, issuedAt })).reverse(),
      items: (data?.acceptances || []).filter((row) => row.version === version).reverse(),
    });
  }
  if (route === '/api/employee-terms/accept' && req.method === 'POST') {
    const input = await body(req);
    const doc = document();
    if (!doc || input?.version !== doc.version || input.hash !== doc.hash) throw stale();
    if (input.accepted !== true) throw fail(400, 'Kabul kutusunu işaretleyin.');
    const existing = terms.acceptance(ctx.state, u, doc);
    if (existing) return reply({ acceptedAt: existing.acceptedAt });
    const acceptedAt = new Date().toISOString();
    save((data) => {
      data.acceptances.push({ ...terms.actor(u), version: doc.version, hash: doc.hash, acceptedAt });
      const reminder = data.reminders.find((row) => row.accountId === u.id && row.version === doc.version);
      if (reminder && !reminder.seenAt) reminder.seenAt = acceptedAt;
    });
    audit('accept', doc.version);
    return reply({ acceptedAt });
  }
  if (route === '/api/employee-terms/reminder-seen' && req.method === 'POST') {
    const input = await body(req);
    const doc = document();
    if (!doc || input?.version !== doc.version || input.hash !== doc.hash) throw stale();
    if (!terms.acceptance(ctx.state, u, doc)) throw fail(403, terms.REQUIRED_MESSAGE);
    const reminder = terms.reminder(ctx.state, u, doc);
    if (reminder && input.sentAt !== reminder.sentAt) throw stale();
    if (reminder)
      save((data) => {
        data.reminders.find((row) => row.accountId === u.id && row.version === doc.version).seenAt =
          new Date().toISOString();
      });
    return reply({ ok: true });
  }
  if (route === '/api/employee-terms/notice-opened' && req.method === 'POST') {
    const input = await body(req);
    const notice = terms.currentNotice(ctx.state);
    if (!notice || input?.version !== notice.version || input.hash !== notice.hash) throw stale();
    if (
      !ctx.state.employeeTerms.noticeEvents.some(
        (row) => row.accountId === u.id && row.version === notice.version && row.hash === notice.hash,
      )
    )
      save((data) =>
        data.noticeEvents.push({
          ...terms.actor(u),
          version: notice.version,
          hash: notice.hash,
          openedAt: new Date().toISOString(),
        }),
      );
    return reply({ ok: true });
  }
  if (route === '/api/employee-terms/settings') {
    if (u.role !== 'ceo') throw fail(403, 'Sözleşmeyi yalnızca CEO yönetebilir.');
    if (req.method === 'GET')
      return reply({
        document: document(),
        draft: document() || terms.draft(),
        notice: terms.currentNotice(ctx.state),
        users: activeUsers().map(({ id, name, username }) => ({ id, name, username })),
      });
    if (req.method === 'PUT') {
      const input = await body(req);
      const now = new Date().toISOString();
      if (input?.action === 'publish') {
        if ((document()?.version || null) !== input.baseVersion) throw stale();
        const release = terms.newRelease(input, now);
        if (ctx.state.employeeTerms?.releases.some((row) => row.version === release.version))
          throw fail(409, 'Bu sürüm numarası kullanıldı. Yeni bir sürüm numarası girin.');
        save((data) => {
          data.releases.push({ ...release, publishedBy: terms.actor(u) });
          data.activeVersion = release.version;
        });
        audit('publish', release.version);
        return reply({ document: document() });
      }
      if (input?.action === 'resend') {
        const doc = document();
        if (!doc || input.version !== doc.version) throw stale();
        const recipients =
          input.recipient === 'all'
            ? activeUsers()
            : activeUsers().filter((user) => user.id === input.recipient);
        if (!recipients.length) throw fail(400, 'Etkin bir kullanıcı seçin.');
        const ids = new Set(recipients.map((user) => user.id));
        save((data) => {
          data.reminders = data.reminders.filter(
            (row) => row.version !== doc.version || !ids.has(row.accountId),
          );
          data.reminders.push(
            ...recipients.map((user) => ({
              accountId: user.id,
              version: doc.version,
              sentAt: now,
              seenAt: null,
              sentBy: u.id,
            })),
          );
        });
        audit('resend', doc.version);
        return reply({ recipients: recipients.length });
      }
      if (input?.action === 'notice') {
        const notice = input.enabled === false ? null : terms.newNotice(input);
        if (
          notice &&
          ctx.state.employeeTerms?.notices.some(
            (row) => row.version === notice.version && row.hash !== notice.hash,
          )
        )
          throw fail(409, 'Bağlantı değiştiyse yeni bir aydınlatma sürümü girin.');
        save((data) => {
          if (notice && !data.notices.some((row) => row.version === notice.version))
            data.notices.push({ ...notice, issuedAt: now });
          data.noticeVersion = notice?.version || null;
        });
        return reply({ notice: terms.currentNotice(ctx.state) });
      }
    }
  }
  throw fail(404, 'İşlem bulunamadı.');
}

module.exports = { handleEmployeeTermsRoutes };

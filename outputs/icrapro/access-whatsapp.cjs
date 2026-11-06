const wa = require('../../lib/whatsapp.cjs');

const manager = (user) => ['ceo', 'admin'].includes(user?.role);

function throttle(ctx, bucket, maximum) {
  const address = ctx.options.secureCookies
    ? ctx.req.headers['x-vercel-forwarded-for'] || ctx.req.socket?.remoteAddress
    : ctx.req.socket?.remoteAddress;
  const key =
    bucket +
    ':' +
    ctx.crypto
      .createHash('sha256')
      .update(String(address || 'unknown'))
      .digest('hex');
  const now = Date.now();
  const previous = ctx.attempts.get(key);
  const rate = previous?.until > now ? previous : { count: 0, until: now + 900000 };
  if (rate.count >= maximum) throw ctx.fail(429, 'Çok fazla deneme yapıldı. Daha sonra tekrar deneyin.');
  rate.count++;
  ctx.attempts.set(key, rate);
}

function accountTarget(ctx, id) {
  if (!manager(ctx.u)) throw ctx.fail(403, 'Yönetici yetkisi gerekli.');
  const target = ctx.state.users.find((user) => user.id === id);
  if (!target) throw ctx.fail(404, 'Kullanıcı bulunamadı.');
  if (target.role === 'ceo' && ctx.u.role !== 'ceo')
    throw ctx.fail(403, 'CEO hesabını yalnızca CEO yönetebilir.');
  return target;
}

function requestReset(ctx, user, { silent }) {
  const cfg = ctx.state.whatsappConfig;
  if (!cfg?.enabled || !cfg.resetTemplate) throw wa.unavailable();
  const phone = wa.contactPhone(ctx.state, user);
  if (!user || !ctx.userEnabled(user) || !phone) {
    if (silent) return;
    throw ctx.fail(409, 'Kullanıcı etkin olmalı ve onaylı bir WhatsApp numarası kayıtlı olmalı.');
  }
  const next = structuredClone(ctx.state);
  const request = wa.reserveReset(next, user);
  if (!request) {
    if (silent) return;
    throw ctx.fail(429, 'Bu hesap şifre bağlantısı talep sınırına ulaştı.');
  }
  ctx.persist(next);
  wa.queueDirect(
    ctx.res,
    next,
    'resetTemplate',
    {
      to: phone,
      values: request.remaining.map(String),
      linkSuffix: request.token,
    },
    { silent },
  );
}

function documentJob(ctx, input) {
  const { state, u, fail } = ctx;
  const { documentId, clientId, attachmentIndex, documentIds, kind, eventId, remember, consent } = input;
  if (
    !['file', 'photo', 'receipt', 'release', 'collection', 'clientAttachment', 'batchReceipt'].includes(
      kind,
    ) ||
    consent !== true
  )
    throw fail(400, 'Dosya türünü ve alıcının gönderim onayını doğrulayın.');
  const phone = wa.normalizePhone(input.phone);
  if (!phone) throw fail(400, 'Geçerli bir WhatsApp numarası girin.');
  const { docs, clients } = state.data['icrapro-v1'];
  if (kind === 'clientAttachment') {
    if (!manager(u) && !u.permissions.includes('clients')) throw fail(403, 'Müvekkil yetkisi gerekli.');
    const client = clients.find((row) => row.id === clientId);
    const attachment =
      Number.isInteger(attachmentIndex) && attachmentIndex >= 0
        ? client?.attachments?.[attachmentIndex]
        : null;
    if (!attachment || !/^data:(application\/pdf|image\/(?:png|jpeg));base64,/i.test(attachment.data || ''))
      throw fail(404, 'Gönderilebilecek bir PDF veya fotoğraf bulunamadı.');
    const template = attachment.data.startsWith('data:image/') ? 'imageTemplate' : 'documentTemplate';
    wa.queueDirect(ctx.res, state, template, {
      to: phone,
      values: [attachment.name || 'Müvekkil evrakı'],
      media: { kind, attachment },
    });
    if (remember) {
      const next = structuredClone(state);
      next.data['icrapro-v1'].clients.find((row) => row.id === client.id).whatsappPhone = phone;
      ctx.persist(next);
    }
    return;
  }
  if (kind === 'batchReceipt') {
    if (
      !Array.isArray(documentIds) ||
      !documentIds.length ||
      documentIds.length > 50 ||
      new Set(documentIds).size !== documentIds.length
    )
      throw fail(400, 'En fazla 50 farklı evrak seçin.');
    const selected = documentIds.map((id) => docs.find((row) => row.id === id));
    if (selected.some((doc) => !doc || (!manager(u) && (!u.staffId || doc.relatedStaff !== u.staffId))))
      throw fail(404, 'Gruptaki tüm evraklara gönderim yetkiniz olmalı.');
    wa.queueDirect(ctx.res, state, 'documentTemplate', {
      to: phone,
      values: ['Teslim tesellüm tutanağı'],
      media: { kind, docs: selected, clients, firm: state.data['icrapro-settings-v1']?.firm },
    });
    return;
  }
  const doc = docs.find((row) => row.id === documentId);
  if (!doc || (!manager(u) && (!u.staffId || doc.relatedStaff !== u.staffId)))
    throw fail(404, 'Gönderebileceğiniz evrak bulunamadı.');
  const template = kind === 'photo' ? 'imageTemplate' : 'documentTemplate';
  if (!state.whatsappConfig?.enabled || !state.whatsappConfig[template]) throw wa.unavailable();
  const client = clients.find((row) => row.id === doc.client);
  const firm = state.data['icrapro-settings-v1']?.firm;
  const event =
    kind === 'collection'
      ? state.data['hanhukuk-finance-v1'].find(
          (row) => row.id === eventId && row.documentId === doc.id && row.type === 'payment',
        )
      : null;
  if (
    (kind === 'file' && !doc.fileData) ||
    (kind === 'photo' && !doc.photoData) ||
    (kind === 'collection' && !event)
  )
    throw fail(404, 'Gönderilecek dosya bulunamadı.');
  if (kind === 'release') {
    const rows = state.data['hanhukuk-finance-v1'].filter((item) => item.documentId === doc.id);
    const paid = rows
      .filter((item) => item.type === 'payment')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const charges =
      doc.docType === 'Yediemin Park Ücreti'
        ? 0
        : Math.round((Number(doc.financeInterest || 0) + Number(doc.financeFee || 0)) * 100) +
          rows
            .filter((item) => item.type === 'expense')
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const remaining =
      Math.round(Number(doc.amount || 0) * 100) + charges - Number(doc.debtDiscountCents || 0) - paid;
    if (doc.status !== 'İnfaz' || !doc.closedDate || !Number.isFinite(remaining) || remaining > 0)
      throw fail(409, 'İbraname yalnızca borcu tamamen ödenmiş infaz evrakı için gönderilebilir.');
  }
  if (remember) {
    const next = structuredClone(state);
    const target = next.data['icrapro-v1'].docs.find((row) => row.id === doc.id);
    target.whatsappPhone = phone;
    ctx.persist(next);
  }
  wa.queueDirect(ctx.res, state, template, {
    to: phone,
    values: [doc.number || 'Evrak'],
    media: { kind, doc, client, firm, event },
  });
}

async function handleWhatsAppRoutes(ctx) {
  const { req, res, url, u, send, fail, body } = ctx;
  const route = url.pathname;
  if (route === '/api/password-reset/request' && req.method === 'POST') {
    throttle(ctx, 'password-wa-request', 8);
    const input = String((await body(req)).account || '').trim();
    if (!input || input.length > 80) throw fail(400, 'Telefon veya kullanıcı adı girin.');
    const username = input.toLocaleLowerCase('tr');
    const phone = wa.normalizePhone(input);
    const matches = ctx.state.users.filter(
      (user) =>
        ctx.userEnabled(user) &&
        (user.username === username || (phone && wa.contactPhone(ctx.state, user) === phone)),
    );
    requestReset(ctx, matches.length === 1 ? matches[0] : null, { silent: true });
    send(res, 200, { ok: true });
    return true;
  }
  if (route === '/api/password-reset/complete' && req.method === 'POST') {
    throttle(ctx, 'password-wa-complete', 12);
    const { token, password } = await body(req);
    if (typeof password !== 'string' || password.length < 10 || password.length > 128)
      throw fail(400, 'Yeni şifre 10–128 karakter olmalı.');
    const next = structuredClone(ctx.state);
    const match = wa.readReset(next, token);
    if (!match || !ctx.userEnabled(match.user))
      throw fail(400, 'Bağlantı geçersiz veya süresi dolmuş. Yeni bağlantı isteyin.');
    match.row.expires = Date.now();
    match.user.salt = ctx.crypto.randomBytes(16).toString('hex');
    match.user.hash = ctx.hash(password, match.user.salt);
    ctx.invalidate(match.user.id);
    res.hanAuditActor = { id: match.user.id, name: match.user.name, username: match.user.username };
    ctx.persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (route === '/api/password-reset/send' && req.method === 'POST') {
    const user = accountTarget(ctx, (await body(req)).userId);
    requestReset(ctx, user, { silent: false });
    send(res, 200, { ok: true });
    return true;
  }
  if (route === '/api/whatsapp/config') {
    if (u?.role !== 'ceo') throw fail(403, 'WhatsApp bağlantısını yalnızca CEO yönetebilir.');
    if (req.method === 'PUT') {
      const next = structuredClone(ctx.state);
      next.whatsappConfig = wa.configure(next.whatsappConfig, await body(req));
      ctx.persist(next);
    } else if (req.method !== 'GET') throw fail(405, 'Yöntem desteklenmiyor.');
    send(res, 200, wa.publicConfig(ctx.state.whatsappConfig));
    return true;
  }
  if (route === '/api/whatsapp/contact') {
    const input = req.method === 'GET' ? { userId: url.searchParams.get('userId') } : await body(req);
    const user = accountTarget(ctx, input.userId);
    const staff = ctx.state.data['icrapro-personnel-v1'].find((row) => row.id === user.staffId);
    if (req.method === 'GET') {
      send(res, 200, {
        phone: user.whatsappPhone || wa.normalizePhone(staff?.phone),
        allowed: !!user.whatsappAllowed,
      });
    } else if (req.method === 'PUT') {
      const phone = input.phone ? wa.normalizePhone(input.phone) : '';
      if ((input.phone && !phone) || (input.allowed === true && !phone))
        throw fail(400, 'Onaylı gönderim için geçerli bir numara girin.');
      if (
        phone &&
        ctx.state.users.some(
          (other) =>
            other.id !== user.id &&
            (wa.normalizePhone(other.whatsappPhone) === phone || wa.contactPhone(ctx.state, other) === phone),
        )
      )
        throw fail(409, 'Bu numara başka bir hesapta kayıtlı.');
      const next = structuredClone(ctx.state);
      const target = next.users.find((row) => row.id === user.id);
      target.whatsappPhone = phone;
      target.whatsappAllowed = input.allowed === true;
      ctx.persist(next);
      send(res, 200, { phone, allowed: target.whatsappAllowed });
    } else throw fail(405, 'Yöntem desteklenmiyor.');
    return true;
  }
  if (route === '/api/whatsapp/document' && req.method === 'POST') {
    if (!u) throw fail(401, 'Giriş yapın.');
    throttle(ctx, 'whatsapp-document', 15);
    documentJob(ctx, await body(req));
    send(res, 200, { ok: true });
    return true;
  }
  if (route === '/api/whatsapp/reminder' && req.method === 'POST') {
    if (!u) throw fail(401, 'Giriş yapın.');
    throttle(ctx, 'whatsapp-reminder', 20);
    const { orderId } = await body(req);
    const order = (ctx.state.workOrders || []).find((row) => row.id === orderId);
    if (!order || (!manager(u) && order.assignerId !== u.id) || order.status !== 'pending')
      throw fail(404, 'Hatırlatma gönderebileceğiniz bekleyen iş emri bulunamadı.');
    const target = ctx.state.users.find((user) => user.id === order.assigneeId && ctx.userEnabled(user));
    const phone = wa.contactPhone(ctx.state, target);
    if (!phone) throw fail(409, 'Alıcının onaylı WhatsApp numarası bulunamadı.');
    wa.queueDirect(res, ctx.state, 'reminderTemplate', {
      to: phone,
      values: [u.name, order.title, order.due || 'Belirtilmedi'],
    });
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

module.exports = { handleWhatsAppRoutes };

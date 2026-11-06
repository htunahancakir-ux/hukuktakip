const scheduled = require('../../lib/scheduled-reminders.cjs');
const wa = require('../../lib/whatsapp.cjs');

async function handleScheduledReminderRoutes(ctx) {
  const { req, res, url, u, body, fail, send, crypto } = ctx;
  if (url.pathname !== '/api/scheduled-reminders') return false;
  const reply = (result) => {
    send(res, 200, result);
    return true;
  };
  const enabled = () =>
    Boolean(
      ctx.options.localReminderScheduler ||
      (ctx.options.reminderScheduler && ctx.state.reminderScheduler?.hash),
    );
  const rows = () => ctx.state.scheduledReminders || [];
  if (req.method === 'GET') {
    const items = rows().filter((row) => row.accountId === u.id);
    const closed = url.searchParams.get('status') === 'closed';
    return reply({
      whatsappAvailable: scheduled.deliveryAvailable(ctx.state, u, enabled()),
      dueCount: items.filter((row) => !row.closedAt && Date.parse(row.dueAt) <= Date.now()).length,
      items: url.searchParams.has('summary')
        ? []
        : items
            .filter((row) => !!row.closedAt === closed)
            .sort((a, b) => (closed ? b.closedAt.localeCompare(a.closedAt) : a.dueAt.localeCompare(b.dueAt)))
            .slice(0, 200)
            .map(({ phoneHash, targetType, targetId, ...row }) => ({
              ...row,
              target: scheduled.targetFor(ctx.state, u, targetType, targetId),
            })),
    });
  }
  if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
  const input = await body(req);
  const next = structuredClone(ctx.state);
  next.scheduledReminders ||= [];
  if (['complete', 'cancel'].includes(input?.action)) {
    const row = next.scheduledReminders.find((row) => row.accountId === u.id && row.id === input.id);
    if (!row) throw fail(404, 'Hatırlatma bulunamadı.');
    if (!row.closedAt) {
      row.closedAt = new Date().toISOString();
      row.closeReason = input.action;
      if (row.deliveryStatus === 'pending') row.deliveryStatus = 'cancelled';
      ctx.persistMetadata(next);
      res.hanReminderAudit = { action: 'update', id: row.id };
    }
    return reply({ ok: true });
  }
  if (input?.action !== 'create') throw fail(400, 'Geçerli bir hatırlatma işlemi seçin.');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  const dueAt = scheduled.scheduleTime(String(input.date || ''), String(input.time || ''));
  if (!note || note.length > 1000 || !dueAt)
    throw fail(400, 'En fazla 1.000 karakter not ve gelecekte bir tarih/saat girin.');
  if (input.targetType && !scheduled.targetFor(ctx.state, u, input.targetType, input.targetId))
    throw fail(404, 'Seçtiğiniz müvekkil veya dosya bulunamadı.');
  if (rows().filter((row) => row.accountId === u.id && !row.closedAt).length >= 200)
    throw fail(409, 'Yeni hatırlatma eklemek için bekleyen bir hatırlatmayı tamamlayın.');
  const whatsapp = input.whatsapp === true;
  if (whatsapp && !scheduled.deliveryAvailable(ctx.state, u, enabled()))
    throw fail(409, 'WhatsApp için onaylı numara, etkin bağlantı, şablon ve zamanlayıcı gerekir.');
  const id = crypto.randomUUID();
  next.scheduledReminders.push({
    id,
    accountId: u.id,
    note,
    dueAt,
    createdAt: new Date().toISOString(),
    targetType: input.targetType || null,
    targetId: input.targetType ? input.targetId : null,
    deliveryStatus: whatsapp ? 'pending' : 'off',
    phoneHash: whatsapp ? scheduled.digest(wa.contactPhone(ctx.state, u)) : undefined,
  });
  ctx.persistMetadata(next);
  res.hanReminderAudit = { action: 'create', id };
  return reply({ id });
}

module.exports = { handleScheduledReminderRoutes };

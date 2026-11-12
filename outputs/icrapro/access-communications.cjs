const { createWorkOrderBatch } = require('../../lib/work-order-batch.cjs');
const { queue: queueWhatsApp } = require('../../lib/whatsapp.cjs');
const { messageSummary } = require('../../lib/notification-summary.cjs');

async function handleCommunicationRoutes(ctx) {
  const { req, res, url, u, persist, userEnabled, fail, body, send, crypto } = ctx;
  if (url.pathname === '/api/marketing-prospects') {
    const manager = ['ceo', 'admin'].includes(u.role);
    const marketingStaff = ctx.state.data['icrapro-personnel-v1'].some(
      (p) =>
        p.id === u.staffId &&
        p.active !== false &&
        String(p.department || '')
          .trim()
          .toLocaleLowerCase('tr-TR') === 'pazarlama',
    );
    if (!manager && !marketingStaff) throw fail(403, 'Pazarlama bölümüne erişim yetkiniz yok.');
    if (req.method === 'GET') {
      const items = (ctx.state.marketingProspects || []).filter((item) => manager || item.createdBy === u.id);
      send(res, 200, { items });
      return true;
    }
    const editing = req.method === 'PUT';
    if (editing && !manager) throw fail(403, 'Yalnız yöneticiler kayıtları düzenleyebilir.');
    if (!editing && req.method !== 'POST') throw fail(405, 'Yöntem desteklenmiyor.');
    const input = await body(req);
    const clean = (key, max) => {
      const value = String(input?.[key] || '').trim();
      if (value.length > max) throw fail(400, 'Alan çok uzun: ' + key);
      return value;
    };
    const company = clean('company', 200),
      date = clean('date', 10),
      time = clean('time', 5),
      contact = clean('contact', 200),
      phone = clean('phone', 30),
      city = clean('city', 100),
      district = clean('district', 100),
      address = clean('address', 1000),
      notes = clean('notes', 3000),
      requestedStaff = clean('staffId', 200),
      status = clean('status', 30);
    if (!['Potansiyel Müvekkil', 'Mevcut Müvekkil'].includes(status)) throw fail(400, 'Durum seçin.');
    if (!company || !date || (status === 'Potansiyel Müvekkil' && (!city || !district)))
      throw fail(400, 'Firma adı ve tarih gereklidir; potansiyel müvekkil için il ve ilçe de girilmelidir.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time)))
      throw fail(400, 'Geçerli tarih ve saat girin.');
    const staffId = manager ? requestedStaff : u.staffId || '';
    const staff = ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === staffId && p.active !== false);
    if (!staff && !(manager && status === 'Mevcut Müvekkil' && !staffId))
      throw fail(400, 'Aktif bir personel seçin.');
    const next = structuredClone(ctx.state);
    const records = next.marketingProspects || [];
    const index = editing ? records.findIndex((item) => item.id === input.id) : -1;
    if (editing && index < 0) throw fail(404, 'Kayıt bulunamadı.');
    const record = {
      ...(editing
        ? records[index]
        : { id: crypto.randomUUID(), createdBy: u.id, createdAt: new Date().toISOString() }),
      company,
      date,
      time,
      contact,
      phone,
      city,
      district,
      address,
      notes,
      staffId,
      staffName: staff?.name || u.name,
      status,
    };
    if (editing) records[index] = record;
    else records.push(record);
    next.marketingProspects = records;
    persist(next);
    send(res, 201, { ok: true });
    return true;
  }
  if (url.pathname === '/api/work-orders' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') || 'mine',
      status = url.searchParams.get('status') || 'pending';
    if (!['mine', 'created', 'all'].includes(scope) || !['pending', 'done', 'all'].includes(status))
      throw fail(400, 'Geçerli iş emri filtresi seçin.');
    if (scope === 'all' && !['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)),
      rows = (ctx.state.workOrders || [])
        .filter(
          (w) =>
            (scope === 'all' || (scope === 'mine' ? w.assigneeId === u.id : w.assignerId === u.id)) &&
            (status === 'all' || w.status === status) &&
            (url.searchParams.get('notification') !== '1' ||
              require('../../lib/daily-notifications.cjs').current(w, u)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    send(res, 200, { total: rows.length, offset, orders: rows.slice(offset, offset + 50) });
    return true;
  }
  if (url.pathname === '/api/work-orders' && req.method === 'POST') {
    const v = await body(req);
    const { next, orders, assignees } = createWorkOrderBatch(ctx.state, v, u, userEnabled, () =>
      crypto.randomUUID(),
    );
    persist(next);
    if (v.whatsapp === true)
      queueWhatsApp(res, next, 'reminderTemplate', assignees, () => ({
        values: [u.name, orders[0].title, orders[0].due || 'Belirtilmedi'],
      }));
    send(res, 201, { ok: true, id: orders[0].id, ids: orders.map((order) => order.id) });
    return true;
  }
  if (url.pathname === '/api/work-orders/complete' && req.method === 'POST') {
    const v = await body(req),
      before = (ctx.state.workOrders || []).find((w) => w.id === v.id);
    if (!before || before.assigneeId !== u.id)
      throw fail(404, 'İş emri bulunamadı veya bu iş size atanmamış.');
    if (before.status === 'done') {
      send(res, 200, { ok: true });
      return true;
    }
    const result = String(v.result || '');
    if (!['Borçlu Arandı', 'İcra Açıldı', 'Diğer'].includes(result)) throw fail(400, 'İş sonucunu seçin.');
    const note = String(v.note || '').trim();
    if (note.length > 3000) throw fail(400, 'Tamamlama notu en fazla 3.000 karakter olabilir.');
    const next = structuredClone(ctx.state),
      order = next.workOrders.find((w) => w.id === v.id),
      now = new Date().toISOString();
    Object.assign(order, {
      status: 'done',
      completedAt: now,
      completedBy: u.id,
      completionResult: result,
      completionNote: note,
    });
    next.messages = [
      ...(next.messages || []),
      {
        id: crypto.randomUUID(),
        senderId: u.id,
        senderName: u.name,
        recipientIds: [order.assignerId],
        recipientNames: [order.assignerName],
        subject: (result + ' — ' + order.title).slice(0, 150),
        text:
          u.name +
          ' tarafından tamamlandı.\nİş sonucu: ' +
          result +
          '\n\n' +
          order.title +
          (note ? '\n\nTamamlama notu: ' + note : ''),
        workOrderId: order.id,
        systemType: 'workOrderCompleted',
        createdAt: now,
        readBy: {},
      },
    ];
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/message-users' && req.method === 'GET') {
    send(
      res,
      200,
      ctx.state.users
        .filter((x) => userEnabled(x) && x.id !== u.id)
        .map((x) => ({ id: x.id, name: x.name, role: x.role })),
    );
    return true;
  }
  if (url.pathname === '/api/messages/summary' && req.method === 'GET') {
    send(res, 200, messageSummary(ctx.state, u));
    return true;
  }
  if (url.pathname === '/api/messages/read' && req.method === 'POST') {
    const v = await body(req),
      message = (ctx.state.messages || []).find((m) => m.id === v.id);
    if (
      !message ||
      (!['ceo', 'admin'].includes(u.role) &&
        message.senderId !== u.id &&
        !message.recipientIds.includes(u.id))
    )
      throw fail(404, 'Mesaj bulunamadı.');
    if (message.recipientIds.includes(u.id) && !message.readBy?.[u.id]) {
      const next = structuredClone(ctx.state),
        m = next.messages.find((x) => x.id === message.id);
      m.readBy = { ...(m.readBy || {}), [u.id]: new Date().toISOString() };
      persist(next);
    }
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/messages') {
    if (req.method === 'GET') {
      const box = url.searchParams.get('box') || 'inbox';
      if (!['inbox', 'sent', 'all'].includes(box)) throw fail(400, 'Geçerli mesaj kutusu seçin.');
      if (box === 'all' && !['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)),
        list = (ctx.state.messages || [])
          .filter(
            (m) => box === 'all' || (box === 'sent' ? m.senderId === u.id : m.recipientIds.includes(u.id)),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      send(res, 200, {
        total: list.length,
        offset,
        messages: list.slice(offset, offset + 50).map((m) => ({
          id: m.id,
          senderId: m.senderId,
          senderName: m.senderName,
          recipientIds: m.recipientIds,
          recipientNames: m.recipientNames,
          subject: m.subject,
          text: m.text,
          workOrderId: m.workOrderId || '',
          systemType: m.systemType || '',
          createdAt: m.createdAt,
          isUnread:
            m.recipientIds.includes(u.id) &&
            !m.readBy?.[u.id] &&
            require('../../lib/daily-notifications.cjs').current(m, u),
          readCount: Object.keys(m.readBy || {}).length,
        })),
      });
      return true;
    }
    if (req.method === 'POST') {
      const v = await body(req),
        subject = String(v.subject || '').trim(),
        messageText = String(v.text || '').trim();
      if (!subject || subject.length > 150 || !messageText || messageText.length > 10000)
        throw fail(400, 'Konu (en fazla 150) ve mesaj (en fazla 10.000 karakter) girin.');
      const requested =
        v.audience === 'all'
          ? ctx.state.users.filter((x) => userEnabled(x) && x.id !== u.id).map((x) => x.id)
          : Array.isArray(v.recipientIds)
            ? [...new Set(v.recipientIds)]
            : [];
      if (
        !requested.length ||
        requested.some(
          (id) =>
            typeof id !== 'string' ||
            id === u.id ||
            !ctx.state.users.some((x) => x.id === id && userEnabled(x)),
        )
      )
        throw fail(400, 'En az bir aktif alıcı seçin.');
      const next = structuredClone(ctx.state);
      next.messages = [
        ...(next.messages || []),
        {
          id: crypto.randomUUID(),
          senderId: u.id,
          senderName: u.name,
          recipientIds: requested,
          recipientNames: requested.map((id) => ctx.state.users.find((x) => x.id === id).name),
          subject,
          text: messageText,
          createdAt: new Date().toISOString(),
          readBy: {},
        },
      ];
      persist(next);
      if (v.whatsapp === true)
        queueWhatsApp(
          res,
          next,
          'messageTemplate',
          requested.map((id) => next.users.find((user) => user.id === id)),
          () => ({
            values: [
              u.name,
              subject,
              messageText.length > 850 ? messageText.slice(0, 850) + '…' : messageText,
            ],
          }),
        );
      send(res, 201, { ok: true });
      return true;
    }
    throw fail(405, 'İşlem desteklenmiyor.');
  }
  return false;
}

module.exports = { handleCommunicationRoutes };

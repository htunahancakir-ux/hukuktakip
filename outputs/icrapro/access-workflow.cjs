const { collectionSummary } = require('../../lib/notification-summary.cjs');
const { currentReport, generateReport, fingerprint } = require('../../lib/conversation-report.cjs');
const voipConversations = require('../../lib/voip-conversations.cjs');
async function handleWorkflowRoutes(ctx) {
  const { req, res, url, u, persist, allowed, fail, body, send, crypto, parkingToday, promiseOutstanding } =
    ctx;
  if (url.pathname === '/api/due-installments' && req.method === 'GET') {
    const today = parkingToday(),
      manager = ['ceo', 'admin'].includes(u.role),
      rows = [];
    for (const d of ctx.state.data['icrapro-v1'].docs) {
      if (
        ['İnfaz', 'İade'].includes(d.status) ||
        !d.repaymentPlan ||
        (!manager && (!u.staffId || d.relatedStaff !== u.staffId))
      )
        continue;
      const plan = d.repaymentPlan;
      let paid = Math.max(
        0,
        ctx.state.data['hanhukuk-finance-v1']
          .filter((e) => e.documentId === d.id && e.type === 'payment')
          .reduce((sum, e) => sum + e.amount, 0) - Number(plan.receivedAtCreation || 0),
      );
      for (const [i, r] of (plan.installments || []).entries()) {
        const applied = Math.min(paid, r.amount);
        paid -= applied;
        const remaining = r.amount - applied;
        if (r.due <= today && remaining > 0)
          rows.push({
            documentId: d.id,
            number: d.number,
            debtor: d.debtor,
            staffId: d.relatedStaff || '',
            staffName:
              ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === d.relatedStaff)?.name ||
              d.relatedStaffName ||
              'Atanmadı',
            sequence: i + 1,
            due: r.due,
            amount: r.amount,
            paid: applied,
            remaining,
          });
      }
    }
    rows.sort((a, b) => a.due.localeCompare(b.due) || a.debtor.localeCompare(b.debtor, 'tr'));
    send(res, 200, { today, rows });
    return true;
  }
  if (url.pathname === '/api/call-reminders' && req.method === 'GET') {
    const now = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(new Date())
      .replace(' ', 'T');
    const rows = [];
    for (const d of ctx.state.data['icrapro-v1'].docs) {
      if (['İnfaz', 'İade'].includes(d.status)) continue;
      for (const c of d.conversations || []) {
        const r = c.callReminder;
        if (!r || r.done || r.date + 'T' + r.time > now) continue;
        if (
          !['ceo', 'admin'].includes(u.role) &&
          c.operatorId !== u.id &&
          (!u.staffId || d.relatedStaff !== u.staffId)
        )
          continue;
        rows.push({
          documentId: d.id,
          conversationId: c.id,
          debtor: d.debtor,
          number: d.number,
          staffId: d.relatedStaff || '',
          staffName:
            ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === d.relatedStaff)?.name ||
            d.relatedStaffName ||
            c.staffName ||
            'Atanmadı',
          createdByName: c.staffName || '',
          ...r,
        });
      }
    }
    rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    send(res, 200, { rows });
    return true;
  }
  if (url.pathname === '/api/call-reminders/done' && req.method === 'POST') {
    const v = await body(req),
      d = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId),
      c = d?.conversations?.find((c) => c.id === v.conversationId);
    if (
      !c?.callReminder ||
      (!['ceo', 'admin'].includes(u.role) &&
        c.operatorId !== u.id &&
        (!u.staffId || u.staffId !== d.relatedStaff))
    )
      throw fail(403, 'Arama hatırlatmasına erişilemiyor.');
    const next = structuredClone(ctx.state),
      r = next.data['icrapro-v1'].docs
        .find((x) => x.id === d.id)
        .conversations.find((x) => x.id === c.id).callReminder;
    r.done = true;
    r.completedBy = u.id;
    r.completedAt = new Date().toISOString();
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/documents/conversation-report' && req.method === 'POST') {
    const v = await body(req);
    if (v.force !== undefined && typeof v.force !== 'boolean')
      throw fail(400, 'Rapor yenileme ayarı geçersiz.');
    const d = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId);
    if (
      !d ||
      !allowed(u, 'documents') ||
      (!['ceo', 'admin'].includes(u.role) && (!u.staffId || d.relatedStaff !== u.staffId))
    )
      throw fail(403, 'Bu dosyanın görüşme raporuna erişilemiyor.');
    const combined = voipConversations.merge(
      d.conversations,
      (req.hanVoipHistory || ctx.state.voipCalls || []).filter((c) => c.documentId === d.id),
    );
    let report = v.force ? null : currentReport({ ...d, conversations: combined }, ctx.state.aiConfig);
    if (!report) {
      const reportKey = d.id + ':' + fingerprint(combined);
      const cache = req.hanConversationReportCache;
      report = cache?.get(reportKey);
      if (
        !report ||
        report.configHash !== require('../../lib/ai-settings.cjs').configFingerprint(ctx.state.aiConfig)
      ) {
        report = await generateReport(combined, { aiConfig: ctx.state.aiConfig });
        cache?.set(reportKey, report);
      }
      const next = structuredClone(ctx.state);
      next.data['icrapro-v1'].docs.find((x) => x.id === d.id).conversationReport = report;
      if (report.aiUsage)
        next.aiUsage = require('../../lib/ai-settings.cjs').addUsage(next.aiUsage, report.aiUsage);
      persist(next);
    }
    send(res, 200, { report });
    return true;
  }
  if (url.pathname === '/api/documents/conversations' && req.method === 'POST') {
    const v = await body(req),
      d = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId);
    if (!d || !allowed(u, 'documents')) throw fail(403, 'Görüşmeyi dosya sorumlusu kaydedebilir.');
    if (!['ceo', 'admin'].includes(u.role) && (!u.staffId || d.relatedStaff !== u.staffId))
      throw fail(403, 'Bu dosyaya erişilemiyor.');
    const calls = (req.hanVoipHistory || ctx.state.voipCalls || []).filter((c) => c.documentId === d.id);
    const call = v.voipCallId ? calls.find((c) => c.id === v.voipCallId) : null;
    if (v.voipCallId) {
      if (!call || (!['ceo', 'admin'].includes(u.role) && call.userId !== u.id))
        throw fail(403, 'Bu arama üzerinde işlem yetkiniz yok.');
      if (['starting', 'ringing', 'answered', 'unknown'].includes(call.status))
        throw fail(409, 'Önce çağrının bittiğini doğrulayın.');
      Object.assign(v, { date: voipConversations.row(call).date, time: voipConversations.row(call).time });
    }
    const date = String(v.date || ''),
      time = String(v.time || ''),
      note = String(v.note || '').trim(),
      now = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .format(new Date())
        .replace(' ', 'T');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      date + 'T' + time > now ||
      note.length > 5000 ||
      !voipConversations.RESULTS.includes(v.result)
    )
      throw fail(400, 'Geçerli tarih, saat, sonuç ve görüşme notu girin.');
    if (v.result === 'Tekrar Aranacak') {
      const r = v.callReminder;
      if (
        !r ||
        !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
        !Number.isFinite(Date.parse(r.date)) ||
        new Date(r.date + 'T00:00:00Z').toISOString().slice(0, 10) !== r.date ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ||
        r.date + 'T' + r.time <= now ||
        String(r.note || '').length > 3000
      )
        throw fail(400, 'Gelecek arama tarihi, saati ve notunu girin.');
    }
    if (
      v.result === 'Ödeme Sözü Alındı' &&
      (!v.paymentPromiseId ||
        v.paymentPromiseId !== d.paymentPromise?.id ||
        !promiseOutstanding(d, ctx.state.data['hanhukuk-finance-v1']))
    )
      throw fail(400, 'Önce ödeme sözü tarihini, tutarını ve açıklamasını kaydedin.');
    const next = structuredClone(ctx.state),
      doc = next.data['icrapro-v1'].docs.find((x) => x.id === d.id);
    const previous = call && doc.conversations?.find((c) => c.voipCallId === call.id);
    doc.conversations = [
      ...(doc.conversations || []).filter((c) => !call || c.voipCallId !== call.id),
      {
        id: previous?.id || crypto.randomUUID(),
        ...(call ? { voipCallId: call.id, phone: call.phone, duration: call.duration } : {}),
        date,
        time,
        note,
        result: v.result,
        callReminder:
          v.result === 'Tekrar Aranacak'
            ? {
                date: v.callReminder.date,
                time: v.callReminder.time,
                note: String(v.callReminder.note || '').trim(),
                done: false,
              }
            : undefined,
        staff: u.staffId || u.id,
        staffName: call?.staffName || u.name,
        operatorId: call?.userId || u.id,
        paymentPromiseId: v.result === 'Ödeme Sözü Alındı' ? d.paymentPromise.id : undefined,
        paymentPromise:
          v.result === 'Ödeme Sözü Alındı'
            ? { id: d.paymentPromise.id, date: d.paymentPromise.date, amount: d.paymentPromise.amount }
            : undefined,
        createdAt: new Date().toISOString(),
      },
    ];
    require('../../lib/test-records.cjs').markRecord(previous, doc.conversations.at(-1), u, 'note');
    const patch = call
      ? { id: call.id, result: v.result, note, resultAt: new Date().toISOString(), resultBy: u.name }
      : null;
    if (patch) require('../../lib/test-records.cjs').markRecord(call, patch, u, 'note');
    const updatedCalls = calls.map((c) => (patch && c.id === patch.id ? { ...c, ...patch } : c));
    doc.conversationReport = await generateReport(voipConversations.merge(doc.conversations, updatedCalls), {
      aiConfig: next.aiConfig,
    });
    if (doc.conversationReport.aiUsage)
      next.aiUsage = require('../../lib/ai-settings.cjs').addUsage(
        next.aiUsage,
        doc.conversationReport.aiUsage,
      );
    if (patch) {
      if (req.hanSaveVoipResult) req.hanSaveVoipResult(patch);
      else
        next.voipCalls = (ctx.state.voipCalls || []).map((c) => {
          if (c.id !== patch.id) return c;
          const copy = { ...c, ...patch };
          delete copy.draftNote;
          delete copy.draftUpdatedAt;
          return copy;
        });
    }
    persist(next);
    send(res, 200, { conversations: doc.conversations, report: doc.conversationReport });
    return true;
  }
  if (url.pathname === '/api/workflow-notices' && req.method === 'GET') {
    send(res, 200, {
      notices: (ctx.state.workflowNotices || [])
        .filter((n) => n.userId === u.id && !n.acknowledgedAt)
        .slice(0, 100),
    });
    return true;
  }
  if (url.pathname === '/api/workflow-notices/ack' && req.method === 'POST') {
    const v = await body(req),
      ids = new Set(Array.isArray(v.ids) ? v.ids : []),
      next = structuredClone(ctx.state);
    for (const notice of next.workflowNotices || [])
      if (notice.userId === u.id && ids.has(notice.id) && !notice.acknowledgedAt)
        notice.acknowledgedAt = new Date().toISOString();
    persist(next);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/payment-promises' && req.method === 'GET') {
    const today = parkingToday(),
      staffId = u.staffId || '',
      rows = ctx.state.data['icrapro-v1'].docs
        .filter(
          (d) =>
            staffId &&
            d.relatedStaff === staffId &&
            !['İnfaz', 'İade'].includes(d.status) &&
            d.paymentPromise &&
            d.paymentPromise.date <= today,
        )
        .map((d) => {
          const p = d.paymentPromise,
            received = ctx.state.data['hanhukuk-finance-v1']
              .filter((e) => e.documentId === d.id && e.type === 'payment')
              .reduce((sum, e) => sum + e.amount, 0),
            paid = Math.max(0, received - Number(p.receivedAtCreation || 0));
          return {
            documentId: d.id,
            number: d.number,
            debtor: d.debtor,
            date: p.date,
            amount: p.amount,
            description: p.description,
            remaining: Math.max(0, p.amount - paid),
          };
        })
        .filter((p) => p.remaining > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
    send(res, 200, { today, rows });
    return true;
  }
  if (url.pathname === '/api/payment-promises/context' && req.method === 'GET') {
    const d = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === url.searchParams.get('documentId'));
    if (!d || (!['ceo', 'admin'].includes(u.role) && (!u.staffId || u.staffId !== d.relatedStaff)))
      throw fail(404, 'Dosya bulunamadı veya size atanmamış.');
    send(res, 200, {
      document: {
        id: d.id,
        number: d.number,
        trackingDate: d.trackingDate,
        created: d.created,
        debtor: d.debtor,
        identity: d.identity,
        phone1: d.phone1,
        address: d.address,
        district: d.district,
        city: d.city,
        relatedStaff: d.relatedStaff,
        relatedStaffName: d.relatedStaffName,
        paymentPromise: d.paymentPromise,
        paymentPromiseHistory: d.paymentPromiseHistory || [],
        conversations: d.conversations || [],
        conversationReport: d.conversationReport,
        status: d.status,
      },
    });
    return true;
  }
  if (url.pathname === '/api/payment-promises' && req.method === 'POST') {
    const v = await body(req),
      doc = ctx.state.data['icrapro-v1'].docs.find((d) => d.id === v.documentId);
    if (!doc || !allowed(u, 'documents'))
      throw fail(403, 'Ödeme sözünü dosya sorumlusu veya yönetici değiştirebilir.');
    if (['İnfaz', 'İade'].includes(doc.status)) throw fail(400, 'Kapalı dosyaya ödeme sözü girilemez.');
    if ((doc.paymentPromise?.id || '') !== (v.previousId || ''))
      throw fail(409, 'Ödeme sözü başka bir işlemde değişti. Yeniden açın.');
    const amount = Number(v.amount),
      date = String(v.date || ''),
      description = String(v.description || '').trim();
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date ||
      !description ||
      description.length > 3000
    )
      throw fail(400, 'Geçerli tarih, pozitif tutar ve açıklama girin.');
    if (date > new Date(Date.parse(parkingToday() + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10))
      throw fail(400, 'Ödeme sözü en fazla 30 gün sonrası için verilebilir.');
    const next = structuredClone(ctx.state),
      d = next.data['icrapro-v1'].docs.find((d) => d.id === doc.id);
    if (d.paymentPromise) d.paymentPromiseHistory = [...(d.paymentPromiseHistory || []), d.paymentPromise];
    d.paymentPromise = {
      id: crypto.randomUUID(),
      date,
      amount,
      description,
      receivedAtCreation: ctx.state.data['hanhukuk-finance-v1']
        .filter((e) => e.documentId === doc.id && e.type === 'payment')
        .reduce((sum, e) => sum + e.amount, 0),
      updatedAt: new Date().toISOString(),
      updatedBy: u.id,
      updatedByName: u.name,
    };
    persist(next);
    send(res, 200, { promise: d.paymentPromise });
    return true;
  }
  if (url.pathname === '/api/collection-notices' && req.method === 'GET') {
    send(res, 200, collectionSummary(ctx.state, url.searchParams.get('after')));
    return true;
  }
  return false;
}

module.exports = { handleWorkflowRoutes };

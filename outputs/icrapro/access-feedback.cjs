const { createFeedbackFiles } = require('../../lib/feedback-files.cjs');

// Geri bildirim: any signed-in user sends a bug report, suggestion or question to technical
// support (later also to sales and marketing), optionally with a screenshot of the page.
// CEO and admins see every entry and answer it; everyone else sees their own entries.
const KINDS = ['bug', 'suggestion', 'question'];
const TARGETS = ['support']; // 'sales' later
const STATUSES = ['open', 'answered', 'closed'];
// Kept in the workspace metadata, which every request reads: the newest 200 are enough.
const MAX_KEPT = 200;
const MAX_SCREENSHOT = 2.5 * 1024 * 1024;
let defaultFiles;

async function handleFeedbackRoutes(ctx) {
  const { req, res, url, u, send, fail, body } = ctx;
  if (url.pathname !== '/api/feedback' && !url.pathname.startsWith('/api/feedback/')) return false;
  const files = ctx.options.feedbackFiles || (defaultFiles ||= createFeedbackFiles());
  const manager = ['ceo', 'admin'].includes(u.role);
  const list = () => ctx.state.feedback || [];
  const view = (f) => ({
    id: f.id,
    kind: f.kind,
    target: f.target,
    message: f.message,
    page: f.page,
    userId: f.userId,
    userName: f.userName,
    createdAt: f.createdAt,
    status: f.status,
    screenshot: !!f.screenshot,
    replies: f.replies || [],
  });

  if (url.pathname === '/api/feedback' && req.method === 'GET') {
    send(res, 200, {
      manager,
      screenshotsAvailable: files.available,
      items: list()
        .filter((f) => manager || f.userId === u.id)
        .map(view),
    });
    return true;
  }

  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    const v = await body(req);
    const message = String(v.message || '').trim();
    if (!KINDS.includes(v.kind)) throw fail(400, 'Geri bildirim türünü seçin: hata, öneri veya soru.');
    if (!TARGETS.includes(v.target || 'support')) throw fail(400, 'Bu alıcı henüz kullanılamıyor.');
    if (message.length < 3 || message.length > 3000) throw fail(400, 'Açıklama 3–3000 karakter olmalı.');
    let screenshot = null;
    if (v.screenshot) {
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(v.screenshot));
      if (!match) throw fail(400, 'Ekran görüntüsü okunamadı.');
      screenshot = Buffer.from(match[1], 'base64');
      if (screenshot.length > MAX_SCREENSHOT) throw fail(400, 'Ekran görüntüsü çok büyük.');
      if (screenshot[0] !== 0xff || screenshot[1] !== 0xd8) throw fail(400, 'Ekran görüntüsü okunamadı.');
    }
    const id = ctx.crypto.randomUUID();
    // The image goes to storage before the entry is saved; without storage the text still goes.
    const stored = screenshot ? await files.save(id, screenshot).catch(() => false) : false;
    const entry = {
      id,
      kind: v.kind,
      target: v.target || 'support',
      message,
      page: String(v.page || '').slice(0, 200),
      userId: u.id,
      userName: u.name,
      createdAt: new Date().toISOString(),
      status: 'open',
      screenshot: stored,
      replies: [],
    };
    const next = structuredClone(ctx.state);
    next.feedback = [entry, ...(next.feedback || [])].slice(0, MAX_KEPT);
    ctx.persist(next);
    send(res, 200, {
      ok: true,
      item: view(entry),
      screenshotSaved: stored,
      screenshotDropped: !!screenshot && !stored,
    });
    return true;
  }

  if (url.pathname === '/api/feedback/screenshot' && req.method === 'GET') {
    const entry = list().find((f) => f.id === url.searchParams.get('id'));
    if (!entry || (!manager && entry.userId !== u.id)) throw fail(404, 'Geri bildirim bulunamadı.');
    if (!entry.screenshot) throw fail(404, 'Bu geri bildirimde ekran görüntüsü yok.');
    const bytes = await files.read(entry.id);
    if (!bytes) throw fail(404, 'Ekran görüntüsü okunamadı.');
    send(res, 200, { dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') });
    return true;
  }

  if (url.pathname === '/api/feedback/reply' && req.method === 'POST') {
    if (!manager) throw fail(403, 'Geri bildirimleri CEO ve yöneticiler yanıtlar.');
    const v = await body(req);
    const next = structuredClone(ctx.state);
    const entry = (next.feedback || []).find((f) => f.id === v.id);
    if (!entry) throw fail(404, 'Geri bildirim bulunamadı.');
    const text = String(v.message || '').trim();
    if (text.length > 3000) throw fail(400, 'Yanıt en fazla 3000 karakter olabilir.');
    if (v.status !== undefined && !STATUSES.includes(v.status)) throw fail(400, 'Durum geçersiz.');
    if (!text && v.status === undefined) throw fail(400, 'Yanıt yazın veya durumu değiştirin.');
    if (text)
      entry.replies = [...(entry.replies || []), { by: u.name, at: new Date().toISOString(), message: text }];
    entry.status = v.status ?? (text ? 'answered' : entry.status);
    ctx.persist(next);
    send(res, 200, { ok: true, item: view(entry) });
    return true;
  }
  throw fail(405, 'İşlem desteklenmiyor.');
}

module.exports = { handleFeedbackRoutes };

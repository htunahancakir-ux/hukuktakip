// Remote support access, office side: a CEO or admin lets the platform's support team into
// the office for a limited time (lib/saas/support-access.cjs keeps the grant and its clock).
// The team works through one hidden account in the office, "Hukuk Takip Platformu Destek":
// an admin that is read-only unless the grant allows changes, cannot sign in with a password,
// is not a purchased user and is not listed among the office's users. Its sessions are created
// only by the access link and end at the grant's deadline.
const SUPPORT_ACCOUNT_ID = 'platform-support';
const MINUTES = [15, 30, 60];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function handleSupportAccountRoutes(ctx) {
  const { req, res, url, u, send, fail, body, persist, crypto } = ctx;
  if (url.pathname !== '/api/support-access/grant') return false;
  // Only where the platform runs a support desk (the cloud office application).
  if (!ctx.options.supportAccess) return false;
  if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
  if (!['ceo', 'admin'].includes(u.role) || u.platformSupport)
    throw fail(403, 'Destek ekibine erişim iznini CEO veya yönetici verebilir.');
  const v = await body(req);
  if (typeof v.ticketId !== 'string' || !UUID.test(v.ticketId)) throw fail(404, 'Destek kaydı bulunamadı.');
  const minutes = Number(v.minutes);
  if (!MINUTES.includes(minutes)) throw fail(400, 'Erişim süresini seçin: 15 dk, 30 dk veya 1 saat.');
  const allowEdit = v.allowEdit === true;
  const next = structuredClone(ctx.state);
  let account = next.users.find((user) => user.id === SUPPORT_ACCOUNT_ID);
  if (!account) {
    account = {
      id: SUPPORT_ACCOUNT_ID,
      name: 'Hukuk Takip Platformu Destek',
      username: 'hukuktakip-destek',
      role: 'admin',
      permissions: [],
      staffId: '',
      // No one knows this password; the account is entered only through an access link.
      salt: crypto.randomBytes(16).toString('hex'),
      hash: crypto.randomBytes(64).toString('hex'),
      platformSupport: true,
      createdAt: new Date().toISOString(),
    };
    next.users.push(account);
  }
  account.active = true;
  account.readOnly = !allowEdit;
  account.role = 'admin';
  account.platformSupport = true;
  persist(next);
  // The grant itself is written to the control plane after this transaction commits
  // (lib/application.cjs finalizeSupportGrant), so a retried transaction grants once.
  res.hanSupportGrant = { ticketId: v.ticketId, minutes, allowEdit, user: { id: u.id, name: u.name } };
  send(res, 200, { ok: true, minutes, allowEdit });
  return true;
}

module.exports = { handleSupportAccountRoutes, SUPPORT_ACCOUNT_ID };

function mobile(value) {
  const digits = String(value || '').replace(/[\s()+.-]/g, '');
  const number = /^5\d{9}$/.test(digits) ? '90' + digits : /^05\d{9}$/.test(digits) ? '9' + digits : digits;
  return /^905\d{9}$/.test(number) ? number : '';
}
function validate(input, fail) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !['email', 'mobilePhone', 'id'].includes(k))
  )
    throw fail(400, 'Yalnızca e-posta ve cep telefonu güncellenebilir.');
  const email = String(input.email || '').trim(),
    phone = String(input.mobilePhone || '').trim();
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw fail(400, 'Geçerli bir e-posta adresi girin.');
  if (phone && (phone.length > 40 || !mobile(phone)))
    throw fail(400, 'Geçerli bir Türkiye cep telefonu girin (05xx xxx xx xx).');
  return { email, mobilePhone: mobile(phone) };
}
function profile(state, user) {
  const staff = state.data['icrapro-personnel-v1']?.find((p) => p.id === user.staffId);
  const email = staff?.email ?? user.email ?? '';
  const phone = staff?.mobilePhone ?? user.mobilePhone ?? mobile(staff?.phone);
  const missing = [
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && 'email',
    !mobile(phone) && 'mobilePhone',
  ].filter(Boolean);
  return {
    id: user.id,
    name: user.name,
    email,
    mobilePhone: phone,
    missing,
    complete: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !!mobile(phone),
  };
}
function update(state, user, values) {
  Object.assign(user, values);
  const staff = state.data['icrapro-personnel-v1']?.find((p) => p.id === user.staffId);
  if (staff) {
    if (!staff.phone || mobile(staff.phone)) staff.phone = values.mobilePhone;
    Object.assign(staff, values);
  }
}
async function handleContact(ctx) {
  const { req, res, url, u, body, send, fail, persist } = ctx;
  const own = url.pathname === '/api/account/contact';
  if (!own && url.pathname !== '/api/users/contact') return false;
  if (!own && !['ceo', 'admin'].includes(u.role))
    throw fail(403, 'Diğer kullanıcıları yalnızca yönetici düzenleyebilir.');
  if (!['GET', 'PUT'].includes(req.method)) throw fail(405, 'Yöntem desteklenmiyor.');
  const input = req.method === 'PUT' ? await body(req) : {};
  if (own && input.id && input.id !== u.id)
    throw fail(403, 'Yalnızca kendi bilgilerinizi güncelleyebilirsiniz.');
  const id = own ? u.id : req.method === 'GET' ? url.searchParams.get('id') : input.id;
  const target = ctx.state.users.find((x) => x.id === id);
  if (!target) throw fail(404, 'Kullanıcı bulunamadı.');
  if (req.method === 'GET') {
    send(res, 200, profile(ctx.state, target));
    return true;
  }
  const values = validate(input, fail),
    next = structuredClone(ctx.state);
  const account = next.users.find((x) => x.id === id);
  update(next, account, values);
  persist(next);
  send(res, 200, profile(next, account));
  return true;
}
module.exports = { mobile, validate, profile, update, handleContact };

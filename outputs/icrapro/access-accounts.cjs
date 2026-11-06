async function handleSessionRoutes(ctx) {
  const {
    req,
    res,
    url,
    u,
    options,
    attempts,
    persist,
    publicUser,
    passwordOK,
    userEnabled,
    login,
    fail,
    body,
    send,
    newUser,
    crypto,
    dataKeys,
  } = ctx;
  if (url.pathname === '/api/session') {
    send(res, 200, { setup: ctx.state.users.length === 0, user: u ? publicUser(u) : null });
    return true;
  }
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    if (options.allowSetup === false || ctx.state.users.length)
      throw fail(403, 'Yönetici kurulumu tamamlandı.');
    const v = await body(req);
    if (ctx.state.users.length) throw fail(403, 'Yönetici kurulumu tamamlandı.');
    const user = newUser({ ...v, role: 'ceo' }),
      next = structuredClone(ctx.state);
    next.users.push(user);
    for (const key of dataKeys) {
      const old = v.legacy?.[key];
      if (old !== undefined) next.data[key] = old;
    }
    persist(next);
    login(res, user);
    send(res, 200, publicUser(user));
    return true;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const key = crypto
        .createHash('sha256')
        .update(
          String(
            options.secureCookies
              ? req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown'
              : req.socket?.remoteAddress || 'unknown',
          ),
        )
        .digest('hex'),
      rate = attempts.get(key) || { count: 0, until: Date.now() + 900000 };
    if (rate.until < Date.now()) {
      rate.count = 0;
      rate.until = Date.now() + 900000;
    }
    if (rate.count >= 8) throw fail(429, 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.');
    const v = await body(req),
      user = ctx.state.users.find(
        (u) =>
          u.username ===
            String(v.username || '')
              .trim()
              .toLocaleLowerCase('tr') && userEnabled(u),
      );
    if (!user || !passwordOK(v.password, user)) {
      rate.count++;
      attempts.set(key, rate);
      throw fail(401, 'Kullanıcı adı veya şifre yanlış.');
    }
    attempts.delete(key);
    login(res, user);
    send(res, 200, publicUser(user));
    return true;
  }
  return false;
}

async function handleAccountRoutes(ctx) {
  const {
    req,
    res,
    url,
    u,
    secure,
    persist,
    publicUser,
    hash,
    invalidate,
    fail,
    body,
    send,
    newUser,
    crypto,
    permissions,
  } = ctx;
  if (url.pathname === '/api/users/password' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role))
      throw fail(403, 'Şifre sıfırlamak için yönetici yetkisi gerekli.');
    const v = await body(req),
      target = ctx.state.users.find((x) => x.id === v.id);
    if (!target) throw fail(404, 'Kullanıcı bulunamadı.');
    if (target.role === 'ceo' && u.role !== 'ceo')
      throw fail(403, 'CEO şifresini yalnızca CEO değiştirebilir.');
    if (typeof v.password !== 'string' || v.password.length < 10 || v.password.length > 128)
      throw fail(400, 'Yeni şifre 10–128 karakter olmalı.');
    const next = structuredClone(ctx.state),
      account = next.users.find((x) => x.id === target.id);
    account.salt = crypto.randomBytes(16).toString('hex');
    account.hash = hash(v.password, account.salt);
    account.passwordChangedAt = new Date().toISOString();
    account.passwordChangedBy = u.id;
    persist(next);
    invalidate(target.id);
    if (target.id === u.id)
      res.setHeader('Set-Cookie', 'han_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure);
    send(res, 200, { ok: true, reauthenticate: target.id === u.id });
    return true;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    invalidate(u.id);
    res.setHeader('Set-Cookie', 'han_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/users') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
    if (req.method === 'GET') {
      send(res, 200, ctx.state.users.map(publicUser));
      return true;
    }
    const v = await body(req),
      next = structuredClone(ctx.state);
    if (v.role === 'ceo' && u.role !== 'ceo') throw fail(403, 'CEO yetkisini yalnızca CEO verebilir.');
    if (v.id) {
      const user = next.users.find((x) => x.id === v.id);
      if (!user) throw fail(404, 'Kullanıcı bulunamadı.');
      if (user.role === 'ceo' && u.role !== 'ceo')
        throw fail(403, 'CEO hesabını yalnızca CEO değiştirebilir.');
      if (user.id === u.id && user.role === 'ceo' && v.role !== 'ceo')
        throw fail(400, 'Kendi CEO yetkinizi kaldıramazsınız.');
      if (user.id === u.id && (v.active === false || v.role === 'staff'))
        throw fail(400, 'Kendi yönetici hesabınızı kapatamazsınız.');
      user.name = String(v.name || user.name).trim();
      user.permissions = (v.permissions || []).filter((p) => permissions.includes(p));
      user.role = ['ceo', 'admin'].includes(v.role) ? v.role : 'staff';
      user.active = v.active !== false;
      user.staffId = user.role === 'ceo' ? '' : v.staffId || '';
      if (v.password) {
        if (v.password.length < 10) throw fail(400, 'Şifre en az 10 karakter olmalı.');
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hash(v.password, user.salt);
      }
    } else next.users.push(newUser(v));
    persist(next);
    if (v.id && v.id !== u.id) invalidate(v.id);
    send(res, 200, ctx.state.users.map(publicUser));
    return true;
  }
  return false;
}

module.exports = { handleSessionRoutes, handleAccountRoutes };

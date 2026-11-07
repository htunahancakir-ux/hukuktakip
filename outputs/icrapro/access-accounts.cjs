const { version: appVersion } = require('../../package.json');
const { attemptKey } = require('../../lib/session-policy.cjs');

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
    if (req.method !== 'GET') throw fail(405, 'İşlem desteklenmiyor.');
    send(res, 200, {
      setup: options.allowSetup !== false && ctx.state.users.length === 0,
      user: u ? publicUser(u) : null,
      employeeTermsRequired: ctx.termsRequired,
      appVersion,
      recordStore: options.recordStore === true,
    });
    return true;
  }
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    if (options.allowSetup === false || ctx.state.users.length)
      throw fail(403, 'Yönetici kurulumu tamamlandı.');
    const v = await body(req);
    if (ctx.state.users.length) throw fail(403, 'Yönetici kurulumu tamamlandı.');
    const user = await newUser({ ...v, role: 'ceo' }),
      next = structuredClone(ctx.state);
    next.users.push(user);
    for (const key of dataKeys) {
      const old = v.legacy?.[key];
      if (old !== undefined) next.data[key] = old;
    }
    persist(next);
    login(req, res, user);
    send(res, 200, publicUser(user));
    return true;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const key = attemptKey(req, options.secureCookies),
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
    if (!user || !(await passwordOK(v.password, user))) {
      rate.count++;
      attempts.set(key, rate);
      throw fail(401, 'Kullanıcı adı veya şifre yanlış.');
    }
    attempts.delete(key);
    if (
      !login(req, res, user, {
        remember: v.remember === true || v.remember === 'on',
        replaceSessions: v.replaceSessions === true,
      })
    ) {
      send(res, 409, {
        code: 'session_replacement_required',
        error:
          'Bu hesapla aynı türde bir cihazda oturum açık. Tüm cihazlardan çıkılacaktır. Girişe devam etmek istiyor musunuz?',
      });
      return true;
    }
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
    clearSessionCookie,
    persist,
    publicUser,
    userEnabled,
    hash,
    passwordOK,
    invalidate,
    login,
    sessionIsValid,
    fail,
    body,
    send,
    newUser,
    crypto,
    permissions,
    sessions,
  } = ctx;
  if (url.pathname === '/api/presence') {
    if (req.method === 'POST') {
      send(res, 200, { ok: true });
      return true;
    }
    if (req.method !== 'GET') throw fail(405, 'İşlem desteklenmiyor.');
    if (u.role !== 'ceo') throw fail(403, 'Aktif kullanıcı listesi yalnızca CEO içindir.');
    const now = Date.now();
    const activeAfter = now - 3 * 60 * 1000;
    const active = new Map();
    for (const session of sessions.values()) {
      if (
        !sessionIsValid(session, now) ||
        !Number.isFinite(session.seenAt) ||
        !Number.isFinite(new Date(session.seenAt).getTime()) ||
        session.seenAt < activeAfter
      )
        continue;
      const account = ctx.state.users.find((user) => user.id === session.id && userEnabled(user));
      if (!account) continue;
      const previous = active.get(account.id);
      if (!previous || previous.lastSeenAt < session.seenAt)
        active.set(account.id, {
          id: account.id,
          name: account.name,
          role: account.role,
          lastSeenAt: session.seenAt,
        });
    }
    send(res, 200, {
      active: [...active.values()].sort(
        (a, b) => b.lastSeenAt - a.lastSeenAt || a.name.localeCompare(b.name, 'tr'),
      ),
      windowMinutes: 3,
    });
    return true;
  }
  if (url.pathname === '/api/account/password' && req.method === 'POST') {
    const v = await body(req);
    if (!(await passwordOK(v.currentPassword, u))) throw fail(400, 'Mevcut şifreniz yanlış.');
    if (typeof v.password !== 'string' || v.password.length < 10 || v.password.length > 128)
      throw fail(400, 'Yeni şifre 10–128 karakter olmalı.');
    const next = structuredClone(ctx.state);
    const account = next.users.find((user) => user.id === u.id);
    account.salt = crypto.randomBytes(16).toString('hex');
    account.hash = await hash(v.password, account.salt);
    account.passwordChangedAt = new Date().toISOString();
    account.passwordChangedBy = u.id;
    persist(next);
    invalidate(u.id);
    login(req, res, account);
    send(res, 200, { ok: true });
    return true;
  }
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
    account.hash = await hash(v.password, account.salt);
    account.passwordChangedAt = new Date().toISOString();
    account.passwordChangedBy = u.id;
    persist(next);
    invalidate(target.id);
    if (target.id === u.id) clearSessionCookie(res);
    send(res, 200, { ok: true, reauthenticate: target.id === u.id });
    return true;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    invalidate(u.id);
    clearSessionCookie(res);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/users') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
    if (req.method === 'GET') {
      send(res, 200, ctx.state.users.map(publicUser));
      return true;
    }
    if (req.method !== 'POST') throw fail(405, 'İşlem desteklenmiyor.');
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
        if (typeof v.password !== 'string' || v.password.length < 10 || v.password.length > 128)
          throw fail(400, 'Şifre 10–128 karakter olmalı.');
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = await hash(v.password, user.salt);
      }
    } else next.users.push(await newUser(v));
    persist(next);
    if (v.id && v.id !== u.id) invalidate(v.id);
    send(res, 200, ctx.state.users.map(publicUser));
    return true;
  }
  return false;
}

module.exports = { handleSessionRoutes, handleAccountRoutes };

const { assertWithinUserLimit } = require('../../lib/seat-limit.cjs');

async function handlePersonnelRoutes(ctx) {
  const {
    req,
    res,
    url,
    u,
    persist,
    hash,
    invalidate,
    fail,
    body,
    send,
    newUser,
    crypto,
    permissions,
    parkingToday,
    isCallcenter,
    calculateCallcenterBonus,
    applyParkingFee,
    recognizedCollectionRevenue,
  } = ctx;
  if (url.pathname === '/api/payroll-report' && req.method === 'GET') {
    const month = url.searchParams.get('month') || parkingToday().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail(400, 'Geçerli ay seçin.');
    const period = ctx.state.payrollPeriods?.[month];
    send(res, 200, {
      month,
      closed: !!period?.closed,
      rows: period?.rows || [],
      availableMonths: Object.keys(ctx.state.payrollPeriods || {})
        .sort()
        .reverse(),
      missing: !period,
    });
    return true;
  }
  if (url.pathname === '/api/report-data' && req.method === 'GET') {
    const records = structuredClone(ctx.state.data['icrapro-v1']);
    records.docs.forEach((d) => applyParkingFee(d, parkingToday()));
    send(res, 200, {
      db: records,
      personnel: ctx.state.data['icrapro-personnel-v1'],
      financeEvents: ctx.state.data['hanhukuk-finance-v1'],
      accounting: ctx.state.data['hanhukuk-accounting-v1'],
    });
    return true;
  }
  if (url.pathname === '/api/bonus2' && req.method === 'GET') {
    const month = url.searchParams.get('month') || parkingToday().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail(400, 'Geçerli ay seçin.');
    const calculated = calculateCallcenterBonus(ctx.state, month, 'each'),
      rows = ctx.state.payrollPeriods?.[month]?.closed
        ? ctx.state.payrollPeriods[month].rows.map(
            (r) => r.bonus2Details || { staffId: r.staffId, name: r.name, total: r.bonus2, manual: true },
          )
        : ctx.state.data['icrapro-personnel-v1'].map(
            (p) =>
              calculated.find((r) => r.staffId === p.id) || {
                staffId: p.id,
                name: p.name,
                total: Math.round(Number(p.bonus || 0) * 100),
                manual: true,
              },
          );
    if (['ceo', 'admin'].includes(u.role)) send(res, 200, { month, rows });
    else send(res, 200, { month, total: rows.find((r) => r.staffId === u.staffId)?.total || 0 });
    return true;
  }
  if (url.pathname === '/api/personnel-payroll' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role))
      throw fail(403, 'Maaş ve primi yalnızca yönetici düzenleyebilir.');
    const v = await body(req),
      p = ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === v.staffId);
    if (!p) throw fail(404, 'Personel bulunamadı.');
    const amounts = {};
    for (const key of ['officialSalary', 'unofficialSalary', 'bonus']) {
      if (key === 'unofficialSalary' && !String(v[key] ?? '').trim()) v[key] = 0;
      const n = Number(v[key]);
      if (
        v[key] === '' ||
        v[key] == null ||
        !Number.isFinite(n) ||
        n < 0 ||
        !Number.isSafeInteger(Math.round(n * 100))
      )
        throw fail(400, 'Geçerli maaş ve prim tutarlarını girin.');
      amounts[key] = Math.round(n * 100) / 100;
    }
    if (amounts.officialSalary + amounts.unofficialSalary <= 0)
      throw fail(400, 'Toplam maaş sıfırdan büyük olmalıdır.');
    const next = structuredClone(ctx.state),
      record = next.data['icrapro-personnel-v1'].find((p) => p.id === v.staffId);
    if (isCallcenter(record)) amounts.bonus = record.bonus || 0;
    Object.assign(record, amounts);
    persist(next);
    send(res, 200, { record });
    return true;
  }
  if (url.pathname === '/api/daily-bonuses') {
    const manager = ['ceo', 'admin'].includes(u.role);
    if (req.method === 'GET') {
      const month = url.searchParams.get('month') || parkingToday().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail(400, 'Geçerli ay seçin.');
      const rows = (ctx.state.dailyBonuses || []).filter(
        (e) => e.date.startsWith(month) && (manager || e.staffId === u.staffId),
      );
      send(res, 200, {
        month,
        total: rows.reduce((sum, e) => sum + e.amount, 0),
        ...(manager ? { rows } : {}),
      });
      return true;
    }
    if (req.method === 'POST') {
      if (!manager) throw fail(403, 'Günlük primi yalnızca CEO ve yönetici ekleyebilir.');
      const v = await body(req),
        staff = ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === v.staffId),
        amount = Number(v.amount),
        date = String(v.date || ''),
        note = String(v.note || '').trim();
      if (
        !staff ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date ||
        !note ||
        note.length > 3000
      )
        throw fail(400, 'Personel, geçerli tarih, pozitif tutar ve açıklama girin.');
      const next = structuredClone(ctx.state);
      next.dailyBonuses = [
        ...(next.dailyBonuses || []),
        {
          id: crypto.randomUUID(),
          staffId: staff.id,
          staffName: staff.name,
          date,
          amount,
          note,
          createdBy: u.id,
          createdByName: u.name,
          createdAt: new Date().toISOString(),
        },
      ];
      persist(next);
      send(res, 201, { ok: true });
      return true;
    }
  }
  if (url.pathname === '/api/my-dashboard' && req.method === 'GET') {
    const period = url.searchParams.get('period') || 'month',
      date = url.searchParams.get('date') || parkingToday();
    if (
      !['day', 'month', 'year'].includes(period) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date))
    )
      throw fail(400, 'Geçerli dönem ve tarih seçin.');
    const staff = ctx.state.data['icrapro-personnel-v1'].find((p) => p.id === u.staffId),
      ids = new Set(
        u.staffId
          ? ctx.state.data['icrapro-v1'].docs.filter((d) => d.relatedStaff === u.staffId).map((d) => d.id)
          : [],
      );
    const keys =
      period === 'day'
        ? [date]
        : period === 'year'
          ? Array.from({ length: 12 }, (_, i) => date.slice(0, 4) + '-' + String(i + 1).padStart(2, '0'))
          : Array.from(
              { length: new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0)).getUTCDate() },
              (_, i) => date.slice(0, 7) + '-' + String(i + 1).padStart(2, '0'),
            );
    const payments = ctx.state.data['hanhukuk-finance-v1'].filter(
      (e) =>
        e.type === 'payment' &&
        staff &&
        (e.turnoverStaffId || e.collectionStaffId || (ids.has(e.documentId) ? staff.id : '')) === staff.id,
    );
    const rows = keys.map((key) => {
      const events = payments.filter((e) => (period === 'year' ? e.date.startsWith(key) : e.date === key));
      return {
        key,
        collected: events.reduce((sum, e) => sum + e.amount, 0),
        grossProfit: events.reduce(
          (sum, e) =>
            sum +
            recognizedCollectionRevenue(
              e,
              ctx.state.data['hanhukuk-finance-v1'],
              ctx.state.data['icrapro-v1'].docs.find((d) => d.id === e.documentId),
            ),
          0,
        ),
      };
    });
    const collected = rows.reduce((sum, r) => sum + r.collected, 0),
      grossProfit = rows.reduce((sum, r) => sum + r.grossProfit, 0),
      mode = 'pending',
      rate = 0,
      bonus = 0;
    send(res, 200, {
      linked: !!staff,
      rows,
      collected,
      grossProfit,
      bonus:
        calculateCallcenterBonus(ctx.state, date.slice(0, 7), 'each').find((r) => r.staffId === u.staffId)
          ?.total ?? Math.round(Number(staff?.bonus || 0) * 100),
      dailyBonusTotal: (ctx.state.dailyBonuses || [])
        .filter((e) => e.staffId === u.staffId && e.date.startsWith(date.slice(0, 7)))
        .reduce((sum, e) => sum + e.amount, 0),
      dailyBonusMonth: date.slice(0, 7),
      commissionMode: mode,
      commissionRate: rate,
    });
    return true;
  }
  if (url.pathname === '/api/personnel-save' && req.method === 'POST') {
    if (!['ceo', 'admin'].includes(u.role)) throw fail(403, 'Yönetici yetkisi gerekli.');
    const v = await body(req),
      record = v.record,
      account = v.account || {};
    if (!record?.id || !String(record.name || '').trim()) throw fail(400, 'Geçerli personel girin.');
    if (!String(record.unofficialSalary ?? '').trim()) record.unofficialSalary = 0;
    for (const key of ['officialSalary', 'unofficialSalary']) {
      if (
        record[key] == null ||
        String(record[key]).trim() === '' ||
        !Number.isFinite(Number(record[key])) ||
        Number(record[key]) < 0
      )
        throw fail(400, 'Geçerli maaş ve prim tutarı girin.');
    }
    if (Number(record.officialSalary) <= 0) throw fail(400, 'Maaş sıfırdan büyük olmalıdır.');
    const next = structuredClone(ctx.state),
      index = next.data['icrapro-personnel-v1'].findIndex((p) => p.id === record.id);
    let user = next.users.find((x) => x.staffId === record.id);
    const username = String(account.username || '')
        .trim()
        .toLocaleLowerCase('tr'),
      desiredRole = record.department === 'Yönetici' ? 'admin' : 'staff';
    if (desiredRole === 'admin' && !username)
      throw fail(400, 'Yönetici için kullanıcı adı ve şifre tanımlayın.');
    if (!username && account.password) throw fail(400, '?ifre i?in kullan?c? ad? da girin.');
    if (user?.role === 'ceo' && u.role !== 'ceo') throw fail(403, 'CEO hesabını değiştiremezsiniz.');
    if (username) {
      if (next.users.some((x) => x.id !== user?.id && x.username === username))
        throw fail(400, 'Kullanıcı adı kullanılıyor.');
      if (user) {
        user.username = username;
        user.name = record.name;
        user.active = record.active !== false;
        user.permissions = (account.permissions || []).filter((p) => permissions.includes(p));
        if (user.role !== 'ceo') {
          if (user.id === u.id && desiredRole === 'staff')
            throw fail(400, 'Kendi yönetici yetkinizi kaldıramazsınız.');
          user.role = desiredRole;
        }
        if (account.password) {
          if (
            typeof account.password !== 'string' ||
            account.password.length < 10 ||
            account.password.length > 128
          )
            throw fail(400, 'Şifre en az 10 karakter olmalı.');
          user.salt = crypto.randomBytes(16).toString('hex');
          user.hash = await hash(account.password, user.salt);
        }
      } else {
        user = await newUser({
          name: record.name,
          username,
          password: account.password,
          staffId: record.id,
          permissions: account.permissions,
          role: desiredRole,
        });
        user.active = record.active !== false;
        next.users.push(user);
      }
    } else if (user) throw fail(400, 'Kullanıcı adı boş bırakılamaz.');
    if (record.commissionMode && !['fixed', 'profit', 'collection'].includes(record.commissionMode))
      throw fail(400, 'Prim türü geçersiz.');
    if (
      !Number.isFinite(Number(record.commissionRate || 0)) ||
      Number(record.commissionRate || 0) < 0 ||
      Number(record.commissionRate || 0) > 100
    )
      throw fail(400, 'Prim oranı 0–100 arasında olmalı.');
    const contact = require('../../lib/account-contact.cjs');
    const old = next.data['icrapro-personnel-v1'][index];
    for (const key of ['email', 'mobilePhone'])
      if (!Object.hasOwn(record, key) && old && Object.hasOwn(old, key)) record[key] = old[key];
    if (Object.hasOwn(record, 'email') || Object.hasOwn(record, 'mobilePhone')) {
      const values = contact.validate({ email: record.email, mobilePhone: record.mobilePhone }, fail);
      Object.assign(record, values);
      if (user) Object.assign(user, values);
    }
    if (index < 0) next.data['icrapro-personnel-v1'].push(record);
    else next.data['icrapro-personnel-v1'][index] = record;
    assertWithinUserLimit(ctx.options?.userLimit, ctx.state, next, fail);
    persist(next);
    if (user && user.id !== u.id) invalidate(user.id);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

module.exports = { handlePersonnelRoutes };

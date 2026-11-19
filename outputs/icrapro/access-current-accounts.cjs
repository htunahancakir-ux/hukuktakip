const cari = require('../../lib/current-accounts.cjs');
const { accountingAllowed } = require('../../lib/accounting-access.cjs');
const { assertModuleAction } = require('../../lib/module-permissions.cjs');
async function handleCurrentAccounts(ctx) {
  const { url, req, res, u, send, fail, body, persist, allowed } = ctx;
  if (!url.pathname.startsWith('/api/current-accounts')) return false;
  const canRead = accountingAllowed(u, ctx.state.data['icrapro-personnel-v1']);
  if (url.pathname === '/api/current-accounts/options' && req.method === 'GET') {
    if (!canRead && !allowed(u, 'cashIn') && !allowed(u, 'cashOut'))
      throw fail(403, 'Cari seçme yetkiniz yok.');
    send(res, 200, {
      items: cari
        .parties(ctx.state)
        .filter((p) => p.active !== false)
        .map((p) => ({ id: p.id, name: p.name })),
    });
    return true;
  }
  if (!canRead) throw fail(403, 'Cari hesapları yalnızca muhasebe yetkilileri görüntüleyebilir.');
  if (req.method === 'GET') {
    const input = Object.fromEntries(url.searchParams);
    if (url.pathname === '/api/current-accounts') send(res, 200, cari.list(ctx.state, input));
    else if (url.pathname === '/api/current-accounts/statement') {
      const result = cari.statement(ctx.state, input.id, input);
      if (input.export === 'csv') {
        if (result.allItems.length > 20000) throw fail(413, 'Çıktı için tarih aralığını daraltın.');
        const csv = (value) => {
          let text = String(value ?? '');
          if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
          return '"' + text.replaceAll('"', '""') + '"';
        };
        const amount = (value) => {
          const n = BigInt(value || '0'),
            absolute = n < 0n ? -n : n;
          return (n < 0n ? '-' : '') + absolute / 100n + ',' + String(absolute % 100n).padStart(2, '0');
        };
        const rows = [
          ['Cari', result.party.name],
          ['Dönem başı bakiye', amount(result.totals.opening)],
          ['Tarih', 'İşlem', 'Açıklama', 'Kasa/Banka', 'Borç', 'Alacak', 'Bakiye'],
          ...result.allItems
            .slice()
            .reverse()
            .map((e) => [
              e.date,
              e.kind,
              e.note,
              e.account,
              BigInt(e.signed) > 0n ? amount(e.signed) : '',
              BigInt(e.signed) < 0n ? amount(-BigInt(e.signed)) : '',
              amount(e.balance),
            ]),
          [
            'TOPLAM',
            '',
            '',
            '',
            amount(result.totals.debit),
            amount(result.totals.credit),
            amount(result.totals.closing),
          ],
        ];
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cari-ekstre.csv"',
          'Cache-Control': 'no-store',
        });
        res.end('\uFEFF' + rows.map((row) => row.map(csv).join(';')).join('\r\n'));
      } else {
        const { allItems, ...page } = result;
        send(res, 200, page);
      }
    } else throw fail(404, 'Cari ekranı bulunamadı.');
    return true;
  }
  if (req.method !== 'POST') throw fail(405, 'Yöntem desteklenmiyor.');
  if (u.readOnly) throw fail(403, 'Bu hesap salt okunur.');
  const input = await body(req);
  let result;
  if (url.pathname === '/api/current-accounts') {
    assertModuleAction(
      u,
      'accounting',
      cari.parties(ctx.state).some((p) => p.id === input?.id) && input?.revision !== undefined
        ? 'update'
        : 'create',
    );
    result = cari.saveParty(ctx.state, input, u);
  } else if (url.pathname === '/api/current-accounts/from-client') {
    assertModuleAction(u, 'accounting', 'create');
    result = cari.fromClient(ctx.state, input, u);
  } else if (url.pathname === '/api/current-accounts/entries') {
    assertModuleAction(u, 'accounting', 'create');
    result = cari.addEntry(ctx.state, input, u);
  } else if (url.pathname === '/api/current-accounts/link') {
    assertModuleAction(u, 'accounting', 'update');
    result = cari.linkEntry(ctx.state, input, u);
  } else throw fail(404, 'Cari işlemi bulunamadı.');
  if (result.next) {
    if (url.pathname === '/api/current-accounts/from-client') ctx.persistMetadata(result.next);
    else persist(result.next);
  }
  send(res, 200, {
    ok: true,
    ...(result.party ? { party: result.party } : {}),
    ...(result.entry ? { entry: result.entry } : {}),
    ...(result.existing !== undefined ? { existing: result.existing } : {}),
  });
  return true;
}
module.exports = { handleCurrentAccounts };

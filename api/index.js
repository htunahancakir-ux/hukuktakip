// The Vercel deployment is retired (2026-11-17): the application runs on its own server
// (outputs/icrapro/server.cjs). vercel.json sends every request to www.hanhukuktakip.com and
// defines no scheduled jobs. Should a request still reach this function, it answers without
// touching the old Supabase database, so nothing can be written there or backed up from it.
module.exports = function retired(req, res) {
  res.statusCode = 410;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({ error: 'Bu adres kapatıldı. Lütfen https://www.hanhukuktakip.com adresini kullanın.' }),
  );
};

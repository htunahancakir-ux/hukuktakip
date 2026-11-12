const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.WHATSAPP_ENCRYPTION_KEY = 'ab'.repeat(32);
const wa = require('../lib/whatsapp.cjs');

const config = {
  ...wa.configure(
    {},
    {
      enabled: true,
      phoneNumberId: '123456789',
      token: 'Synthetic-Test-Token-Not-For-Provider',
      messageTemplate: 'notice',
    },
  ),
};
const job = (to) => ({ to, values: ['Gönderen', 'Konu', 'Mesaj'] });

test('failed WhatsApp sends report Meta error codes with a Turkish explanation', async () => {
  const fetcher = async (_url, { body }) => {
    const to = JSON.parse(body).to;
    if (to === '905320000001') return Response.json({ messages: [{ id: 'ok' }] });
    if (to === '905320000002' || to === '905320000003')
      return Response.json(
        {
          error: {
            message: '(#132001) Template name does not exist in the translation',
            code: 132001,
            error_subcode: 2494073,
          },
        },
        { status: 404 },
      );
    return Response.json(
      { error: { message: 'Unexpected', code: 987654, error_data: { details: 'Some new Meta problem' } } },
      { status: 400 },
    );
  };
  const result = await wa.deliverWhatsApp(
    {
      config,
      template: 'messageTemplate',
      jobs: ['905320000001', '905320000002', '905320000003', '905320000004'].map(job),
    },
    { fetcher },
  );
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 3);
  assert.deepEqual(result.errors, [
    {
      code: '132001/2494073',
      message: 'Şablon bulunamadı (şablon adı veya dili hatalı ya da onaylanmamış)',
      count: 2,
    },
    { code: '987654', message: 'Some new Meta problem', count: 1 },
  ]);
});

test('timeouts, unreadable keys and successful batches are reported plainly', async () => {
  const timeout = await wa.deliverWhatsApp(
    { config, template: 'messageTemplate', jobs: [job('905320000001')] },
    {
      fetcher: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
    },
  );
  assert.deepEqual(timeout.errors, [{ code: '', message: 'Meta zamanında yanıt vermedi', count: 1 }]);

  const broken = await wa.deliverWhatsApp({
    config: { ...config, sealedToken: 'bm90LWEtdG9rZW4tYXQtYWxsLW5vdC1hLXRva2Vu' },
    template: 'messageTemplate',
    jobs: [job('905320000001'), job('905320000002')],
  });
  assert.equal(broken.failed, 2);
  assert.deepEqual(broken.errors, [
    { code: '', message: 'Kayıtlı Meta erişim anahtarı açılamadı; ayarlardan yeniden girin', count: 2 },
  ]);

  const fine = await wa.deliverWhatsApp(
    { config, template: 'messageTemplate', jobs: [job('905320000001')] },
    { fetcher: async () => Response.json({ messages: [{ id: 'ok' }] }) },
  );
  assert.deepEqual(fine, { accepted: 1, failed: 0, skipped: 0 });
});

test('the delivery notice shows each error code to the user', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('outputs/icrapro/workspace-whatsapp.js', 'utf8'), context);
  const notice = context.whatsappDeliveryNotice({
    whatsapp: {
      accepted: 1,
      failed: 3,
      skipped: 0,
      errors: [
        { code: '132001/2494073', message: 'Şablon bulunamadı', count: 2 },
        { code: '190', message: 'Meta erişim anahtarının süresi dolmuş veya anahtar geçersiz', count: 1 },
      ],
    },
  });
  assert.equal(
    notice,
    ' WhatsApp: 1 gönderim Meta tarafından kabul edildi; 3 gönderim başarısız — Hata 132001/2494073: Şablon bulunamadı (2 gönderim); Hata 190: Meta erişim anahtarının süresi dolmuş veya anahtar geçersiz.',
  );
  assert.equal(
    context.whatsappDeliveryNotice({
      whatsapp: {
        accepted: 0,
        failed: 1,
        errors: [{ code: '', message: 'Meta’ya bağlanılamadı', count: 1 }],
      },
    }),
    ' WhatsApp: 1 gönderim başarısız — Meta’ya bağlanılamadı.',
  );
});

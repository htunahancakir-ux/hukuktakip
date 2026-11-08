// Explicit smoke test uses synthetic notes only. Never reads application data.
const { generateReport } = require('../lib/conversation-report.cjs');
generateReport([
  { date: '2026-11-01', time: '10:00', result: 'Ulaşılamadı', note: 'İlk aramada cevap alınamadı.' },
  {
    date: '2026-11-02',
    time: '11:00',
    result: 'Ödeme Sözü Alındı',
    note: 'İkinci görüşmede 10 Kasım için 1500 TL ödeme sözü verildi. Henüz ödeme yapılmadı.',
  },
])
  .then((report) => {
    if (!report.text || Array.from(report.text).length > 300) throw Error('Invalid summary');
    console.log(
      'CONVERSATION_AI_OK',
      JSON.stringify({ model: report.model, characters: Array.from(report.text).length, text: report.text }),
    );
  })
  .catch((error) => {
    console.error(
      'CONVERSATION_AI_FAILED',
      JSON.stringify({ message: error.message, status: error.gatewayStatus, code: error.gatewayCode }),
    );
    process.exitCode = 1;
  });

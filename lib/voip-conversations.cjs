const RESULTS = [
  'Görüşüldü',
  'Olumlu',
  'Olumsuz',
  'Ulaşılamadı',
  'Meşgul',
  'Tekrar Aranacak',
  'Ödeme Sözü Alındı',
  'Ödemeyi Reddetti',
  'Borca İtiraz',
  'Yanlış Numara',
  'Raporlandı',
  'İcra Raporu',
  'Diğer',
];
function row(call) {
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(call.createdAt));
  return {
    id: 'voip:' + call.id,
    voipCallId: call.id,
    date: stamp.slice(0, 10),
    time: stamp.slice(11, 16),
    createdAt: call.createdAt,
    result: call.result || require('./voip.cjs').STATUS[call.status],
    note: call.note || '',
    staffName: call.staffName,
    staff: call.staffId,
    operatorId: call.userId,
    phone: call.phone,
    duration: call.duration,
    status: call.status,
    ...(call.testRecord ? { testRecord: call.testRecord } : {}),
  };
}
function merge(manual = [], calls = []) {
  const ids = new Set(calls.map((c) => c.id));
  return [
    ...manual.filter((c) => !ids.has(c.voipCallId)),
    ...calls.filter((c) => !['starting', 'ringing', 'answered', 'unknown'].includes(c.status)).map(row),
  ];
}
async function transactionContext(db, request) {
  if (
    !['/api/documents/conversations', '/api/documents/conversation-report'].includes(request?.url?.pathname)
  )
    return {};
  let input;
  try {
    input = JSON.parse(request.raw);
  } catch {
    return {};
  }
  if (typeof input.documentId !== 'string') return {};
  if (input.voipCallId)
    await db.query('SELECT id FROM han_private.voip_calls WHERE id=$1 AND document_id=$2 FOR UPDATE', [
      input.voipCallId,
      input.documentId,
    ]);
  const history = (
    await db.query('SELECT body FROM han_private.voip_calls WHERE document_id=$1 ORDER BY created_at,id', [
      input.documentId,
    ])
  ).rows.map((r) => r.body);
  const updates = [];
  return {
    voipHistory: history,
    saveVoipResult: (patch) => {
      const call = history.find((c) => c.id === patch.id);
      require('./test-records.cjs').markRecord(call, patch, null, 'note');
      updates.push({
        ...patch,
        searchText: [
          call?.clientName,
          call?.documentNumber,
          call?.debtorName,
          call?.phone,
          call?.staffName,
          patch.result,
        ]
          .join(' ')
          .toLocaleLowerCase('tr'),
      });
    },
    async flush() {
      for (const patch of updates) {
        const { searchText, ...body } = patch;
        await db.query(
          `UPDATE han_private.voip_calls SET body=(body || $2::jsonb)-'draftNote'-'draftUpdatedAt',search_text=$3 WHERE id=$1`,
          [patch.id, JSON.stringify(body), searchText],
        );
      }
    },
  };
}
module.exports = { RESULTS, row, merge, transactionContext };

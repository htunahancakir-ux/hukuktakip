const crypto = require('node:crypto');
function staffBreakStatus(state, actor) {
  const user = state.users.find((user) => user.id === actor.id);
  const last = (state.staffBreaks || []).findLast((row) => row.userId === actor.id && row.endedAt);
  return { activeBreak: user?.activeBreak || null, lastBreak: last || null };
}
function changeStaffBreak(state, actor, input, options = {}) {
  input ||= {};
  const fail = (code, message) => {
    throw Object.assign(Error(message), { code });
  };
  if (actor.role !== 'staff') fail(403, 'Mola düğmesi personel hesapları içindir.');
  const now = options.now ?? Date.now(),
    uuid = options.randomUUID || crypto.randomUUID;
  if (!['start', 'end'].includes(input.action)) fail(400, 'Geçerli mola işlemi seçin.');
  const user = state.users.find((user) => user.id === actor.id);
  if (!user) fail(401, 'Giriş yapın.');
  if (input.action === 'start') {
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId))
      fail(400, 'Mola işlem numarası gerekli.');
    const prior = (state.staffBreaks || []).find(
      (row) => row.userId === actor.id && row.requestId === input.requestId,
    );
    if (prior?.endedAt) fail(409, 'Bu mola tamamlandı. Güncel durumu kontrol edin.');
    if (user.activeBreak) return { next: null, status: staffBreakStatus(state, actor) };
  } else {
    const prior = (state.staffBreaks || []).find(
      (row) => row.userId === actor.id && row.id === input.breakId,
    );
    if (prior?.endedAt) return { next: null, status: staffBreakStatus(state, actor) };
    if (!user.activeBreak || user.activeBreak.id !== input.breakId)
      fail(409, 'Açık mola değişti. Sayfayı yenileyin.');
    if (!prior) fail(409, 'Mola kaydı bulunamadı. Yöneticinize bildirin.');
  }
  const next = structuredClone(state),
    current = next.users.find((user) => user.id === actor.id),
    stamp = new Date(now).toISOString();
  next.staffBreaks ||= [];
  let record;
  if (input.action === 'start') {
    record = {
      id: uuid(),
      requestId: input.requestId,
      userId: actor.id,
      userName: actor.name,
      staffId: actor.staffId || '',
      startedAt: stamp,
    };
    next.staffBreaks.push(record);
    current.activeBreak = { id: record.id, startedAt: stamp };
  } else {
    record = next.staffBreaks.find((row) => row.id === input.breakId && row.userId === actor.id);
    record.endedAt = stamp;
    record.durationSeconds = Math.max(0, Math.floor((now - Date.parse(record.startedAt)) / 1000));
    record.durationMinutes = Math.round((record.durationSeconds / 60) * 100) / 100;
    delete current.activeBreak;
  }
  const managers = next.users.filter(
    (user) =>
      ['ceo', 'admin'].includes(user.role) &&
      (options.userEnabled ? options.userEnabled(user) : user.active === true),
  );
  const duration = record.endedAt
    ? `${Math.floor(record.durationSeconds / 60)} dk ${record.durationSeconds % 60} sn`
    : '';
  const text = record.endedAt
    ? `${actor.name} moladan döndü. Mola süresi: ${duration}.`
    : `${actor.name} molaya çıktı.`;
  const subject = record.endedAt
    ? `Mola Bitti · ${actor.name} · ${duration}`
    : `Molaya Çıktı · ${actor.name}`;
  if (managers.length) {
    next.messages = [
      ...(next.messages || []),
      {
        id: uuid(),
        senderId: actor.id,
        senderName: actor.name,
        recipientIds: managers.map((user) => user.id),
        recipientNames: managers.map((user) => user.name),
        subject: subject.slice(0, 150),
        text,
        systemType: record.endedAt ? 'breakEnded' : 'breakStarted',
        breakId: record.id,
        createdAt: stamp,
        readBy: {},
      },
    ];
    next.workflowNotices = [
      ...(next.workflowNotices || []),
      ...managers.map((manager) => ({
        id: uuid(),
        userId: manager.id,
        type: record.endedAt ? 'breakEnded' : 'breakStarted',
        text,
        breakId: record.id,
        createdAt: stamp,
        acknowledgedAt: null,
      })),
    ];
  }
  return { next, status: staffBreakStatus(next, actor) };
}
module.exports = { staffBreakStatus, changeStaffBreak };

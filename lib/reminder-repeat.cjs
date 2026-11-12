const { createHash } = require('node:crypto');
const repeats = Object.freeze({
  none: 'Tekrarlama',
  daily: 'Her Gün',
  weekly: 'Her Hafta',
  monthly: 'Her Ay',
  yearly: 'Her Yıl',
});
const day = 86400000;
function nextOccurrence(anchor, repeat, now, minimumIndex = 1) {
  if (!Object.hasOwn(repeats, repeat) || repeat === 'none' || !Number.isFinite(Date.parse(anchor)))
    return null;
  const base = new Date(Date.parse(anchor) + 3 * 3600000),
    local = new Date(now + 3 * 3600000);
  let index = minimumIndex;
  if (repeat === 'daily' || repeat === 'weekly')
    index = Math.max(
      index,
      Math.floor((now - Date.parse(anchor)) / (day * (repeat === 'weekly' ? 7 : 1))) + 1,
    );
  else if (repeat === 'monthly')
    index = Math.max(
      index,
      (local.getUTCFullYear() - base.getUTCFullYear()) * 12 + local.getUTCMonth() - base.getUTCMonth(),
    );
  else index = Math.max(index, local.getUTCFullYear() - base.getUTCFullYear());
  const at = (n) => {
    if (repeat === 'daily' || repeat === 'weekly')
      return Date.parse(anchor) + n * day * (repeat === 'weekly' ? 7 : 1);
    const year = base.getUTCFullYear() + (repeat === 'yearly' ? n : 0),
      month = base.getUTCMonth() + (repeat === 'monthly' ? n : 0);
    const end = new Date(Date.UTC(year, month + 1, 0));
    return (
      Date.UTC(
        end.getUTCFullYear(),
        end.getUTCMonth(),
        Math.min(base.getUTCDate(), end.getUTCDate()),
        base.getUTCHours(),
        base.getUTCMinutes(),
      ) -
      3 * 3600000
    );
  };
  let due = at(index);
  if (due <= now) due = at(++index);
  if (!Number.isFinite(due) || due <= now) return null;
  return { dueAt: new Date(due).toISOString(), index };
}
function advanceRepeatingReminders(state, now = Date.now(), accountId) {
  const rows = (state.scheduledReminders ||= []);
  let changed = false;
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows.slice()) {
    if (accountId && row.accountId !== accountId) continue;
    if (Array.isArray(state.users) && !state.users.some((user) => user.id === row.accountId && user.active))
      continue;
    if (!row.repeat || row.repeat === 'none' || row.nextReminderId || row.closeReason === 'cancel') continue;
    if (row.closedAt && row.closeReason !== 'complete') continue;
    if (!row.closedAt && Date.parse(row.dueAt) > now) continue;
    const anchor = row.repeatAnchorAt || row.dueAt;
    const next = nextOccurrence(anchor, row.repeat, now, Number(row.repeatIndex || 0) + 1);
    if (!next) continue;
    const series = row.repeatSeriesId || row.id;
    const id =
      'repeat-' +
      createHash('sha256')
        .update(series + '|' + next.index)
        .digest('hex')
        .slice(0, 32);
    row.nextReminderId = id;
    row.nextDueAt = next.dueAt;
    changed = true;
    if (ids.has(id)) continue;
    rows.push({
      id,
      accountId: row.accountId,
      note: row.note,
      targetType: row.targetType || null,
      targetId: row.targetId || null,
      dueAt: next.dueAt,
      createdAt: new Date(now).toISOString(),
      repeat: row.repeat,
      repeatSeriesId: series,
      repeatAnchorAt: anchor,
      repeatIndex: next.index,
      deliveryStatus: row.phoneHash ? 'pending' : 'off',
      ...(row.phoneHash ? { phoneHash: row.phoneHash } : {}),
    });
    ids.add(id);
  }
  return changed;
}
module.exports = { repeats, nextOccurrence, advanceRepeatingReminders };

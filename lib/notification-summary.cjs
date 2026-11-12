function messageSummary(state, user) {
  return {
    pendingWorkOrders: (state.workOrders || []).filter(
      (row) =>
        row.assigneeId === user.id &&
        row.status === 'pending' &&
        require('./daily-notifications.cjs').current(row, user),
    ).length,
    unread: (state.messages || []).filter(
      (row) =>
        row.recipientIds.includes(user.id) &&
        !row.readBy?.[user.id] &&
        require('./daily-notifications.cjs').current(row, user),
    ).length,
  };
}
function collectionSummary(state, raw) {
  const cursor = Number(state.collectionNoticeSequence || 0);
  if (raw === null) return { cursor, notices: [] };
  const after = Number(raw);
  if (!Number.isSafeInteger(after) || after < 0)
    throw Object.assign(new Error('Geçersiz bildirim sırası.'), { code: 400 });
  const notices = (state.collectionNotices || []).filter((row) => row.sequence > after).slice(0, 100);
  return { cursor: notices.length ? notices.at(-1).sequence : cursor, notices };
}
function notificationSummary(state, user, raw, now = Date.now()) {
  return {
    messages: messageSummary(state, user),
    staffBreak: user.role === 'staff' ? user.activeBreak || null : null,
    collections: collectionSummary(state, raw),
    workflow: {
      notices: (state.workflowNotices || [])
        .filter(
          (row) =>
            row.userId === user.id &&
            !row.acknowledgedAt &&
            require('./daily-notifications.cjs').current(row, user),
        )
        .slice(0, 100),
    },
    reminders: {
      dueCount: (state.scheduledReminders || []).filter(
        (row) => row.accountId === user.id && !row.closedAt && Date.parse(row.dueAt) <= now,
      ).length,
    },
  };
}
module.exports = { messageSummary, collectionSummary, notificationSummary };

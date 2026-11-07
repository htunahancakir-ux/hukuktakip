let workspaceNotificationTimer = null;
let workspaceNotificationFlight = null;
let workspaceNotificationStarted = false;
let workspaceNotificationDelay = 15000;

function startWorkspaceNotifications() {
  if (workspaceNotificationStarted) return workspaceNotificationFlight;
  workspaceNotificationStarted = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollWorkspaceNotifications();
  });
  return pollWorkspaceNotifications();
}

function pollWorkspaceNotifications() {
  if (workspaceNotificationFlight) return workspaceNotificationFlight;
  clearTimeout(workspaceNotificationTimer);
  if (!hanAuth || document.hidden) return Promise.resolve();
  workspaceNotificationFlight = (async () => {
    try {
      const suffix = collectionNoticeCursor === null ? '' : '?after=' + collectionNoticeCursor;
      const notificationStartedAt = Date.now();
      const response = await fetch('/api/notifications' + suffix, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401) {
        hanAuth = null;
        location.reload();
        return;
      }
      if (!response.ok) throw new Error('Bildirimler alınamadı.');
      const result = await response.json();
      if (Object.hasOwn(result, 'staffBreak') && typeof applyStaffBreakStatus === 'function')
        applyStaffBreakStatus(result.staffBreak, notificationStartedAt);
      applyMessageSummary(result.messages);
      applyReminderSummary(result.reminders);
      collectionNoticeCursor = result.collections.cursor;
      collectionNoticeQueue.push(...result.collections.notices);
      for (const notice of result.workflow.notices) {
        if (queuedWorkflowNotices.has(notice.id)) continue;
        queuedWorkflowNotices.add(notice.id);
        collectionNoticeQueue.push({ ...notice, workflow: true });
      }
      showNextCollectionNotice();
      workspaceNotificationDelay = 15000;
    } catch {
      workspaceNotificationDelay = Math.min(120000, workspaceNotificationDelay * 2);
    } finally {
      workspaceNotificationFlight = null;
      if (workspaceNotificationStarted && hanAuth)
        workspaceNotificationTimer = setTimeout(
          pollWorkspaceNotifications,
          workspaceNotificationDelay + Math.floor(Math.random() * 1000),
        );
    }
  })();
  return workspaceNotificationFlight;
}

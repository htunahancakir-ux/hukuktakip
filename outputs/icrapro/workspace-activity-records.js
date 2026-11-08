const activityPages = { messages: {}, orders: {}, reminders: {} };
let activityRequest;
async function loadRecordActivity(view) {
  const state = activityPages[view],
    offset = view === 'messages' ? messageOffset : view === 'orders' ? workOrderOffset : reminderListOffset;
  const params =
    view === 'messages'
      ? { box: messageBox }
      : view === 'orders'
        ? { scope: workOrderScope, status: workOrderStatus }
        : { status: reminderListStatus };
  const key = JSON.stringify(params);
  if (state.key !== key) {
    state.key = key;
    state.cursors = [''];
  }
  const index = Math.floor(offset / 50),
    marker = document.createElement('p');
  marker.textContent = 'Kayıtlar yükleniyor…';
  marker.setAttribute('role', 'status');
  $('#content').replaceChildren(marker);
  activityRequest?.abort();
  const request = new AbortController();
  activityRequest = request;
  try {
    const path =
      view === 'messages'
        ? '/api/messages'
        : view === 'orders'
          ? '/api/work-orders'
          : '/api/scheduled-reminders';
    const result = await recordReportFetch(
      path + '?' + new URLSearchParams({ ...params, offset, after: state.cursors[index] || '' }),
      request.signal,
    );
    if (!marker.isConnected || activityRequest !== request) return;
    state.cursors[index + 1] = result.next || '';
    if (view === 'messages') messagesPage(result);
    else if (view === 'orders') workOrdersPage(result);
    else scheduledRemindersPage(result);
  } catch (error) {
    if (error.name === 'AbortError' || !marker.isConnected || activityRequest !== request) return;
    marker.textContent = error.message;
    const retry = document.createElement('button');
    retry.textContent = 'Yeniden Dene';
    retry.onclick = () => loadRecordActivity(view);
    marker.after(retry);
  }
}
function bindReminderPagination(result) {
  const footer = document.createElement('div');
  footer.className = 'tablefoot';
  footer.innerHTML = `<span>${result.total ? reminderListOffset + 1 : 0}–${reminderListOffset + result.items.length} / ${esc(result.total)} hatırlatma</span><div class="toolbar"><button type="button" id="previousReminders" ${reminderListOffset ? '' : 'disabled'}>Önceki</button><button type="button" id="nextReminders" ${result.next ? '' : 'disabled'}>Sonraki</button></div>`;
  $('#content').lastElementChild.append(footer);
  $('#previousReminders').onclick = () => {
    reminderListOffset = Math.max(0, reminderListOffset - 50);
    scheduledRemindersPage();
  };
  $('#nextReminders').onclick = () => {
    reminderListOffset += 50;
    scheduledRemindersPage();
  };
}

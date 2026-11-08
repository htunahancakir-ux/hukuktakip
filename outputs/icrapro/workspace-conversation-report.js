const conversationReportRequests = new Map();
function conversationReportMethod(method) {
  return (
    {
      'vercel-ai-gateway': 'AI Gateway',
      openai: 'OpenAI API',
      'local-extractive': 'Yerel yedek',
    }[method] || 'Bilinmeyen yöntem'
  );
}
async function requestConversationReport(documentId) {
  if (conversationReportRequests.has(documentId)) return conversationReportRequests.get(documentId);
  const task = (async () => {
    const response = await fetch('/api/documents/conversation-report', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (
        data.code === 'staff_on_break' &&
        Object.hasOwn(data, 'activeBreak') &&
        typeof applyStaffBreakStatus === 'function'
      )
        applyStaffBreakStatus(data.activeBreak);
      throw Error(data.error || 'Görüşme özeti oluşturulamadı.');
    }
    const doc = db.docs.find((d) => d.id === documentId);
    if (doc && (doc.conversations || []).length === data.report.sourceCount)
      doc.conversationReport = data.report;
    return data.report;
  })();
  conversationReportRequests.set(documentId, task);
  try {
    return await task;
  } finally {
    conversationReportRequests.delete(documentId);
  }
}
function bindConversationReport(doc, form) {
  const output = form.querySelector('[data-conversation-report]');
  const status = form.querySelector('[data-conversation-report-status]');
  const button = form.querySelector('[data-generate-conversation-report]');
  if (!output || !button) return;
  const refresh = async () => {
    button.disabled = true;
    status.textContent = 'Tüm görüşme geçmişi özetleniyor…';
    try {
      const report = await requestConversationReport(doc.id);
      if (!form.isConnected) return;
      output.value = report.text;
      doc.conversationReport = report;
      output.maxLength = report.maxChars || 300;
      status.textContent =
        Array.from(report.text).length +
        ' / ' +
        (report.maxChars || 300) +
        ' karakter · ' +
        report.sourceCount +
        ' görüşme · ' +
        conversationReportMethod(report.method);
    } catch (error) {
      if (!form.isConnected) return;
      output.value = '';
      status.textContent = error.message;
    } finally {
      if (form.isConnected) button.disabled = false;
    }
  };
  button.onclick = refresh;
  // Generation follows saving the original note; it never replaces that note.
  if ((doc.conversations || []).length) void refresh();
  else status.textContent = 'Görüşme kaydedildiğinde tüm geçmişten otomatik oluşturulur.';
}
async function prepareConversationReportRows(rows, isCurrent = () => true) {
  for (const row of rows) {
    if (!isCurrent()) return false;
    if (!row.cells.reportPending) continue;
    const report = await requestConversationReport(row.documentId);
    if (!isCurrent()) return false;
    row.cells.note = report.text;
    row.cells.reportPending = false;
    for (const cell of document.querySelectorAll('[data-report-summary]'))
      if (cell.dataset.reportSummary === row.documentId) cell.textContent = report.text || '—';
  }
  return true;
}

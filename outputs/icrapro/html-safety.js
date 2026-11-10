// For HTML text and quoted, non-executable attributes only. Never use this
// encoder to interpolate data into JavaScript, CSS, or an event handler.
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function testRecordBadge(record) {
  if (!record?.testRecord?.note) return '';
  return `<small class="test-record-badge" title="${escapeHtml(record.testRecord.note)}">TEST · ${escapeHtml(record.testRecord.userName || 'Teknik Destek')}</small>`;
}

// Attachments in this application are FileReader data URLs. Do not accept
// arbitrary URLs, SVG/HTML, or trailing markup, even from existing records.
function safeAttachmentUrl(value, kind = 'document') {
  if (typeof value !== 'string') return '';
  const match = /^data:(application\/pdf|image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    value,
  );
  if (!match || match[2].length % 4 !== 0) return '';
  const mime = match[1].toLowerCase();
  if (kind === 'photo' && !mime.startsWith('image/')) return '';
  if (kind === 'pdf' && mime !== 'application/pdf') return '';
  return value;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function attachmentDownloadLink(value, name, label, kind = 'document') {
  const url = safeAttachmentUrl(value, kind);
  if (!url) return '<span class="notice">Desteklenmeyen veya geçersiz dosya bağlantısı.</span>';
  return `<a href="${escapeHtml(url)}" download="${escapeHtml(name)}">${escapeHtml(label)}</a>`;
}

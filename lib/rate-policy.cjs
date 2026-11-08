const limits = Object.freeze({
  '/api/documents/conversation-report': ['conversation-report', 120],
  '/api/staff-breaks': ['staff-break', 120],
  '/api/password-reset/request': ['password-wa-request', 8],
  '/api/password-reset/complete': ['password-wa-complete', 12],
  '/api/whatsapp/document': ['whatsapp-document', 15],
  '/api/whatsapp/reminder': ['whatsapp-reminder', 20],
});
module.exports = { limits };

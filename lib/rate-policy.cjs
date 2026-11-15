const limits = Object.freeze({
  '/api/records/folio-reservation': ['folio-reservation', 60],
  '/api/ceo-pin/config': ['ceo-pin-config', 5],
  '/api/ceo-pin/verify': ['ceo-pin-verify', 20],
  '/api/documents/conversation-report': ['conversation-report', 120],
  // Each call asks the provider the CEO typed for its model list; the page waits until typing stops.
  '/api/ai/models': ['ai-models', 60],
  '/api/staff-breaks': ['staff-break', 120],
  '/api/password-reset/request': ['password-wa-request', 8],
  '/api/password-reset/complete': ['password-wa-complete', 12],
  '/api/password-reset/sms-complete': ['password-sms-complete', 12],
  '/api/password-reset/email-complete': ['password-email-complete', 12],
  // "Yöneticiden iste" writes to the managers' inbox.
  '/api/password-reset/ask-manager': ['password-help', 5],
  // Each call sends an e-mail through the platform's Brevo account.
  '/api/email-verification/send': ['email-verify-send', 10],
  '/api/email-verification/confirm': ['email-verify-confirm', 20],
  '/api/email-verification/send-all': ['email-verify-all', 3],
  // Live delivery tests of the office's own recovery channels; each sends a real message.
  '/api/password-reset/channel-test-link': ['recovery-channel-link', 12],
  '/api/sms/recovery-test': ['sms-recovery-test', 10],
  '/api/whatsapp/recovery-test': ['whatsapp-recovery-test', 5],
  // Each call reaches Verimor; a test SMS also costs credit.
  // A screenshot is up to a few megabytes; keep a stuck button or script from flooding storage.
  '/api/feedback': ['feedback', 20],
  '/api/sms/test': ['sms-test', 10],
  '/api/sms/send-test': ['sms-send-test', 5],
  '/api/sms/marketing': ['sms-marketing', 5],
  '/api/whatsapp/document': ['whatsapp-document', 15],
  '/api/whatsapp/reminder': ['whatsapp-reminder', 20],
  // Each call is billed by Google; keep a runaway page or script from running up costs.
  '/api/marketing/search': ['marketing-search', 40],
  '/api/marketing/route-places': ['marketing-details', 30],
  '/api/marketing/test': ['marketing-test', 10],
  // Scraping jobs load the office's own tarama sunucusu; status polls arrive every few seconds.
  '/api/marketing/scrape': ['marketing-scrape', 20],
  '/api/marketing/scrape-status': ['marketing-scrape-status', 300],
});
module.exports = { limits };

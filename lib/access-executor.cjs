const { createAccess } = require('../outputs/icrapro/access-server.cjs');
const { requestEvents } = require('./audit.cjs');

const MAX_BODY = 4 * 1024 * 1024;
const ATTACHMENT_BODY = MAX_BODY + 64 * 1024;
function bufferedResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(body = '') {
      this.body = body;
    },
  };
}
async function executeAccess(context, req, url, raw, options = {}) {
  if (context.recordPatch) raw = Buffer.from(JSON.stringify(context.recordPatch));
  const response = bufferedResponse();
  const replay = {
    url: url.pathname,
    method: req.method,
    headers: req.headers,
    socket: req.socket,
    async *[Symbol.asyncIterator]() {
      if (raw?.length) yield raw;
    },
  };
  // A serializable transaction can retry an AI report after the provider has
  // answered. Preserve that response for the retried request: never bill or
  // wait for the same prompt a second time.
  if (!req.hanConversationReportCache) req.hanConversationReportCache = new Map();
  replay.hanConversationReportCache = req.hanConversationReportCache;
  replay.hanVoipHistory = context.voipHistory;
  replay.hanSaveVoipResult = context.saveVoipResult;
  const access = createAccess(null, {
    initialState: context.state,
    saveState: context.saveState,
    sessions: context.sessions,
    attempts: context.attempts,
    userEnabled: context.userEnabled,
    skipPayroll: context.skipPayroll === true || context.scoped === true,
    payoutAccountBalances: context.payoutAccountBalances,
    cashAccountBalances: context.cashAccountBalances,
    employeeTermsRequired: context.employeeTermsRequired,
    timers: false,
    allowSetup: false,
    requireRevision: true,
    reminderScheduler: true,
    skipAutomations: true,
    audit: true,
    maxBodyBytes: url.pathname === '/api/record-attachments' ? ATTACHMENT_BODY : MAX_BODY,
    ...options,
  });
  await access(replay, response, url);
  response.bytes = Buffer.byteLength(response.body);
  if (response.bytes > MAX_BODY) throw Object.assign(new Error('Response too large'), { status: 413 });
  if (context.appendAudit)
    await context.appendAudit(requestEvents(req, url, raw || Buffer.alloc(0), response));
  return response;
}
module.exports = { MAX_BODY, ATTACHMENT_BODY, bufferedResponse, executeAccess };

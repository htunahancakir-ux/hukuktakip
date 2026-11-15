const { emailAddress, cleanName } = require('./brevo-email.cjs');

// Brevo over SMTP, set in the server's own environment (BREVO_SMTP_LOGIN, BREVO_SMTP_KEY and
// the verified sender BREVO_FROM_EMAIL). It carries the same account e-mails as the platform's
// Brevo account (lib/saas/platform-email.cjs) and is used while that account is not switched on
// in the console, and on an installation without a console. The key stays out of Git, backups
// and the browser. Without the two credentials there is no such sender.
const DEFAULT_NAME = 'Hukuk Takip Platformu';

function fromEnv(env = process.env) {
  if (!env.BREVO_SMTP_LOGIN || !env.BREVO_SMTP_KEY) return null;
  const from = emailAddress(env.BREVO_FROM_EMAIL);
  if (!from) throw new Error('BREVO_FROM_EMAIL must be a valid sender address');
  const transport = require('nodemailer').createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: env.BREVO_SMTP_LOGIN, pass: env.BREVO_SMTP_KEY },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    verify: () => transport.verify(),
    // One message to one recipient, under the office's own name (`fromName`).
    send: ({ to, toName, fromName, subject, text, html }) =>
      transport.sendMail({
        from: { name: cleanName(fromName) || DEFAULT_NAME, address: from },
        to: { address: to, ...(cleanName(toName) && { name: cleanName(toName) }) },
        subject,
        text,
        ...(html && { html }),
        headers: { 'X-Mailin-Track-Clicks': '0', 'X-Mailin-Track-Opens': '0' },
      }),
  };
}

module.exports = { fromEnv };

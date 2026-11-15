// Brevo transactional e-mail API v3 client (https://developers.brevo.com/reference/sendtransacemail).
// `apiKey` is an API key from Brevo → SMTP & API → API keys (it starts with "xkeysib-"; the SMTP
// key "xsmtpsib-" does not work here). When "Authorised IPs" is on in the Brevo account, calls
// from any other server address are answered 401 even with a valid key.
const BASE = 'https://api.brevo.com/v3';
const TIMEOUT_MS = 10000;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

function emailAddress(value) {
  const email = String(value ?? '')
    .trim()
    .toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : '';
}
// ah***@gmail.com — enough to recognise an address in a log without storing it.
function maskEmail(value) {
  const email = emailAddress(value);
  if (!email) return '';
  const [local, domain] = email.split('@');
  return (local.slice(0, Math.min(2, local.length - 1) || 1) + '***@' + domain).slice(0, 120);
}

const NAME_MAX = 70;
const cleanName = (value) =>
  String(value ?? '')
    .replace(/[\r\n<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);

function createBrevoEmail({ apiKey, fetcher = fetch } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw fail(412, 'Brevo e-posta hesabı ayarlanmadı.');
  const call = async (path, init = {}) => {
    let response;
    try {
      response = await fetcher(BASE + path, {
        ...init,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw fail(502, 'Brevo e-posta servisine ulaşılamadı.');
    }
    const text = await response.text().catch(() => '');
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {}
    if (response.status === 401 || response.status === 403)
      throw fail(
        502,
        /ip/i.test(String(body.message || ''))
          ? 'Brevo bu sunucunun IP adresini tanımıyor. Brevo → Ayarlar → Güvenlik → Yetkili IP adresleri bölümünden sunucunun IP adresine izin verin.'
          : 'Brevo API anahtarı geçersiz veya yetkisiz. Brevo → SMTP ve API → API anahtarları bölümünden yeni bir anahtar (xkeysib-…) oluşturun.',
        'UNAUTHORIZED',
      );
    if (response.status === 429) throw fail(429, 'Brevo gönderim hızı sınırına ulaşıldı. Biraz sonra tekrar deneyin.', 'RATE_LIMIT');
    if (!response.ok) {
      const code = String(body.code || '');
      const message = String(body.message || '');
      if (/credit/i.test(code + ' ' + message)) throw fail(502, 'Brevo e-posta kredisi yetersiz.', 'NO_CREDITS');
      if (/sender/i.test(message))
        throw fail(
          502,
          'Gönderen adresi Brevo’da doğrulanmamış. Brevo → Gönderenler ve alan adları bölümünden alan adını doğrulayın.',
          'SENDER',
        );
      throw fail(502, 'Brevo isteği reddetti' + (message ? ': ' + message.slice(0, 160) : '.'), code || 'REJECTED');
    }
    return body;
  };
  return {
    // One message to one recipient. Returns Brevo's message id.
    async send({ sender, to, toName, subject, html, text, tags = [] }) {
      const dest = emailAddress(to);
      if (!dest) throw fail(400, 'Geçerli bir e-posta adresi gerekli.');
      const from = emailAddress(sender?.email);
      if (!from) throw fail(412, 'Gönderen e-posta adresi ayarlanmadı.');
      const body = await call('/smtp/email', {
        method: 'POST',
        body: JSON.stringify({
          sender: { email: from, ...(cleanName(sender.name) && { name: cleanName(sender.name) }) },
          to: [{ email: dest, ...(cleanName(toName) && { name: cleanName(toName) }) }],
          subject: String(subject).slice(0, 200),
          htmlContent: html,
          textContent: text,
          ...(tags.length && { tags }),
        }),
      });
      return { messageId: String(body.messageId || '').slice(0, 200) };
    },
    // The account e-mail and the remaining e-mail credits, for the console's connection test.
    async account() {
      const body = await call('/account');
      const plans = Array.isArray(body.plan) ? body.plan : [];
      const sendLimit = plans.find((plan) => plan.creditsType === 'sendLimit') || plans[0];
      return {
        email: String(body.email || ''),
        plan: String(sendLimit?.type || ''),
        credits: Number.isFinite(Number(sendLimit?.credits)) ? Number(sendLimit.credits) : null,
      };
    },
    // Sender domains and whether Brevo authenticated them (DKIM/DMARC records in DNS).
    async domains() {
      const body = await call('/senders/domains');
      return (Array.isArray(body.domains) ? body.domains : []).map((domain) => ({
        name: String(domain.domain_name || '').toLowerCase(),
        authenticated: domain.authenticated === true,
        verified: domain.verified === true,
      }));
    },
  };
}

module.exports = { createBrevoEmail, emailAddress, maskEmail, cleanName };

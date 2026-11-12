// Verimor SMS API v2 client (https://github.com/verimor/SMS-API/blob/master/user_guide.md).
// `username` is the 12-digit account number (e.g. 908501234567), `password` the API password set
// in the Verimor panel. Verimor only accepts calls from server IPs allowed in the account's SMS
// settings; otherwise it answers 401.
const BASE = 'https://sms.verimor.com.tr/v2';
const TIMEOUT_MS = 10000;

const ERRORS = {
  INSUFFICIENT_CREDITS: 'SMS kredisi yetersiz.',
  INVALID_SOURCE_ADDRESS: 'SMS başlığı geçersiz veya hesapta tanımlı değil.',
  INVALID_DESTINATION_ADDRESS: 'Telefon numarası geçersiz.',
  MESSAGE_TOO_LONG: 'Mesaj çok uzun.',
  MISSING_MESSAGE: 'Mesaj boş.',
  FORBIDDEN_MESSAGE: 'Mesaj içeriği Verimor tarafından reddedildi.',
  NUMERIC_SOURCE_ADDRESS_NOT_ALLOWED: 'Sayısal SMS başlığı kullanılamaz.',
};

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

// Turkish mobile numbers only (90 5xx xxx xx xx): the platform sends to office staff in Turkey.
function smsNumber(value) {
  const digits = String(value ?? '').replace(/[\s()+.-]/g, '');
  const number = /^5\d{9}$/.test(digits) ? '90' + digits : /^05\d{9}$/.test(digits) ? '9' + digits : digits;
  return /^905\d{9}$/.test(number) ? number : '';
}
const maskNumber = (number) => (number ? number.slice(0, 5) + '*****' + number.slice(-2) : '');

// Segment count for cost tracking: 160/153 for plain text, 155/149 with Turkish letters
// (datacoding 1 per the Verimor guide).
function segments(text) {
  const turkish = /[ŞşĞğİıçÇ]/.test(text);
  const single = turkish ? 155 : 160;
  const multi = turkish ? 149 : 153;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function createVerimorSms({ username, password, header = '', fetcher = fetch } = {}) {
  if (!/^\d{10,15}$/.test(String(username || '')) || !password)
    throw fail(412, 'Verimor SMS hesabı ayarlanmadı.');
  const call = async (path, init) => {
    let response;
    try {
      response = await fetcher(BASE + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw fail(502, 'Verimor SMS servisine ulaşılamadı.');
    }
    const text = (await response.text().catch(() => '')).trim();
    if (response.status === 401)
      throw fail(
        502,
        'Verimor kullanıcı adı/şifreyi veya sunucu IP iznini kabul etmedi. Verimor panelinde API şifresini ve izinli IP ayarını kontrol edin.',
        'UNAUTHORIZED',
      );
    if (response.status === 429)
      throw fail(502, 'Verimor istek sınırı aşıldı; biraz sonra tekrar deneyin.', 'RATE_LIMIT');
    if (!response.ok) {
      const code = /^[A-Z_]{3,60}$/.test(text) ? text : 'HTTP_' + response.status;
      throw fail(502, ERRORS[code] || 'Verimor SMS isteği reddedildi (' + code + ').', code);
    }
    return text;
  };
  const query = () =>
    '?username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password);
  return {
    async balance() {
      const text = await call('/balance' + query(), { method: 'GET' });
      const credits = Number(text);
      if (!Number.isFinite(credits)) throw fail(502, 'Verimor bakiye yanıtı okunamadı.');
      return credits;
    },
    async headers() {
      const text = await call('/headers' + query(), { method: 'GET' });
      try {
        const list = JSON.parse(text);
        if (!Array.isArray(list)) throw new Error('shape');
        return list.filter((item) => typeof item === 'string').slice(0, 50);
      } catch {
        throw fail(502, 'Verimor başlık listesi okunamadı.');
      }
    },
    // Returns Verimor's campaign id. Informational (not commercial) message: no IYS fields.
    async send({ to, text }) {
      const dest = smsNumber(to);
      if (!dest) throw fail(400, 'Geçerli bir Türkiye cep telefonu gerekli.');
      const msg = String(text || '');
      if (!msg.trim() || msg.length > 900) throw fail(400, 'SMS metni geçersiz.');
      const campaign = await call('/send.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          ...(header ? { source_addr: header } : {}),
          valid_for: '00:30',
          messages: [{ msg, dest }],
        }),
      });
      return { campaignId: campaign.slice(0, 64), dest };
    },
  };
}

module.exports = { createVerimorSms, smsNumber, maskNumber, segments, BASE };

const crypto = require('node:crypto');

const limits = Object.freeze([
  { days: 1, max: 1 },
  { days: 7, max: 3 },
  { days: 30, max: 8 },
]);
const DAY = 86400000;
const templateKeys = [
  'resetTemplate',
  'messageTemplate',
  'reminderTemplate',
  'documentTemplate',
  'imageTemplate',
];
const resetDigest = (token) => crypto.createHash('sha256').update(token).digest('hex');
const unavailable = () =>
  Object.assign(new Error('WhatsApp bağlantısı veya ilgili mesaj şablonu henüz ayarlanmadı.'), { code: 503 });

function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+\d\s().-]{8,30}$/.test(raw)) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (/^05\d{9}$/.test(digits)) digits = '9' + digits;
  if (/^5\d{9}$/.test(digits)) digits = '90' + digits;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
}

function credentialKey() {
  const raw = process.env.WHATSAPP_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw unavailable();
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-whatsapp-v1', 32),
  );
}

function sealToken(token) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), nonce);
  return Buffer.concat([nonce, cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString(
    'base64',
  );
}

function openToken(sealed) {
  const bytes = Buffer.from(sealed, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
}

function publicConfig(saved = {}) {
  const { enabled = false, phoneNumberId = '', version = 'v23.0', language = 'tr' } = saved;
  return {
    enabled,
    phoneNumberId,
    version,
    language,
    tokenSaved: Boolean(saved.sealedToken),
    ...Object.fromEntries(templateKeys.map((key) => [key, saved[key] || ''])),
  };
}

function configure(saved, input) {
  const bad = (message) => Object.assign(new Error(message), { code: 400 });
  const { enabled, phoneNumberId = '', version = 'v23.0', language = 'tr', token = '' } = input || {};
  if (
    typeof enabled !== 'boolean' ||
    (phoneNumberId && !/^\d{6,30}$/.test(phoneNumberId)) ||
    !/^v\d{1,2}\.\d$/.test(version) ||
    !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)
  )
    throw bad('Telefon numarası kimliği, API sürümü veya dil kodu geçersiz.');
  if (typeof token !== 'string' || token.length > 4096 || (token && !/^[a-zA-Z0-9._|\-]{20,}$/.test(token)))
    throw bad('Meta erişim anahtarı biçimi geçersiz.');
  const config = {
    enabled,
    phoneNumberId,
    version,
    language,
    sealedToken: token ? sealToken(token) : saved?.sealedToken,
  };
  for (const key of templateKeys) {
    const name = input[key] || '';
    if (typeof name !== 'string' || (name && !/^[a-z0-9_]{1,128}$/.test(name)))
      throw bad('Şablon adlarında küçük harf, rakam ve alt çizgi kullanın.');
    config[key] = name;
  }
  if (enabled && (!phoneNumberId || !config.sealedToken))
    throw bad('Etkinleştirmek için telefon kimliğini ve erişim anahtarını girin.');
  return config;
}

function contactPhone(state, user) {
  if (!user?.whatsappAllowed) return '';
  return normalizePhone(
    user.whatsappPhone ||
      state.data['icrapro-personnel-v1']?.find((person) => person.id === user.staffId)?.phone,
  );
}

function reserveReset(state, user, now = Date.now()) {
  const requests = (state.passwordRecovery || []).filter((row) => row.at > now - 30 * DAY);
  const used = requests.filter((row) => row.userId === user.id);
  const remaining = limits.map(
    ({ days, max }) => max - used.filter((row) => row.at > now - days * DAY).length,
  );
  if (remaining.some((count) => count <= 0)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  for (const row of used) if (row.hash && row.expires > now) row.expires = now;
  requests.push({
    userId: user.id,
    at: now,
    expires: now + 15 * 60000,
    hash: resetDigest(token),
    fingerprint: resetDigest(user.hash),
  });
  state.passwordRecovery = requests;
  return { token, remaining: remaining.map((count) => count - 1) };
}

function readReset(state, token, now = Date.now()) {
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
  const hash = resetDigest(token);
  const row = (state.passwordRecovery || []).find((item) => item.hash === hash && item.expires > now);
  if (!row) return null;
  const user = state.users.find((item) => item.id === row.userId);
  return user && row.fingerprint === resetDigest(user.hash) ? { row, user } : null;
}

function queue(res, state, template, recipients, makeJob, { silent = false } = {}) {
  const config = state.whatsappConfig;
  const jobs = [];
  let skipped = 0;
  const seen = new Set();
  for (const user of recipients) {
    const phone = contactPhone(state, user);
    if (!phone || !config?.enabled || !config[template] || seen.has(phone) || jobs.length >= 100) {
      skipped++;
      continue;
    }
    seen.add(phone);
    jobs.push({ to: phone, ...makeJob(user) });
  }
  res.hanWhatsApp = { config, template, jobs, skipped, silent };
}

function textParameters(values) {
  return values.map((value) => ({
    type: 'text',
    text: String(value || '—')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900),
  }));
}

function queueDirect(res, state, template, job, options) {
  if (!state.whatsappConfig?.enabled || !state.whatsappConfig[template]) throw unavailable();
  res.hanWhatsApp = { config: state.whatsappConfig, template, jobs: [job], skipped: 0, ...options };
}

async function deliverWhatsApp(batch, { fetcher = fetch, renderMedia } = {}) {
  const { config, template, jobs, skipped = 0 } = batch;
  let accepted = 0,
    failed = 0;
  if (!jobs.length) return { accepted, failed, skipped };
  let token;
  try {
    token = openToken(config.sealedToken);
  } catch {
    return { accepted, failed: jobs.length, skipped };
  }
  const base = `https://graph.facebook.com/${config.version}/${config.phoneNumberId}/`;
  const send = async (endpoint, body, isForm = false) => {
    const response = await fetcher(base + endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(9000),
      headers: { Authorization: 'Bearer ' + token, ...(!isForm && { 'Content-Type': 'application/json' }) },
      body: isForm ? body : JSON.stringify(body),
    });
    if (!response.ok) throw Error('Meta API request rejected');
    return response.json();
  };
  async function deliver(job) {
    try {
      const components = [];
      if (job.media) {
        const file = await renderMedia(job.media);
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', file.mime);
        form.append('file', new Blob([file.bytes], { type: file.mime }), file.name);
        const uploaded = await send('media', form, true);
        if (!uploaded.id) throw Error('Meta media ID missing');
        const type = file.mime.startsWith('image/') ? 'image' : 'document';
        components.push({
          type: 'header',
          parameters: [
            {
              type,
              [type]: {
                id: uploaded.id,
                ...(type === 'document' && { filename: file.name }),
              },
            },
          ],
        });
      }
      if (job.values?.length) components.push({ type: 'body', parameters: textParameters(job.values) });
      if (job.linkSuffix)
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: job.linkSuffix }],
        });
      const result = await send('messages', {
        messaging_product: 'whatsapp',
        to: job.to,
        type: 'template',
        template: { name: config[template], language: { code: config.language }, components },
      });
      if (!result.messages?.[0]?.id) throw Error('Meta message ID missing');
      accepted++;
    } catch {
      failed++;
    }
  }
  for (let i = 0; i < jobs.length; i += 10) await Promise.all(jobs.slice(i, i + 10).map(deliver));
  return { accepted, failed, skipped };
}

module.exports = {
  normalizePhone,
  publicConfig,
  configure,
  contactPhone,
  reserveReset,
  readReset,
  queue,
  queueDirect,
  deliverWhatsApp,
  unavailable,
};

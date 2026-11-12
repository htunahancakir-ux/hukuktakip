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

// Meta Cloud API error codes the office can act on, in Turkish. Anything else shows Meta's own text.
const META_ERRORS = {
  0: 'Meta kimlik doğrulaması başarısız; erişim anahtarını yenileyin',
  1: 'Meta geçici bir hata bildirdi; biraz sonra yeniden deneyin',
  2: 'Meta hizmeti geçici olarak kullanılamıyor',
  3: 'Uygulamanın bu işlem için yetkisi yok',
  4: 'Meta istek sınırı aşıldı; biraz sonra yeniden deneyin',
  10: 'Erişim anahtarının bu işlem için izni yok',
  100: 'Meta isteği geçersiz buldu (telefon numarası kimliği veya alanlar hatalı)',
  190: 'Meta erişim anahtarının süresi dolmuş veya anahtar geçersiz',
  200: 'Erişim anahtarının bu işlem için izni yok',
  368: 'Hesap politika ihlali nedeniyle geçici olarak engellendi',
  80007: 'WhatsApp hesabının istek sınırı aşıldı',
  130429: 'Saniyelik gönderim sınırı aşıldı; biraz sonra yeniden deneyin',
  130472: 'Alıcının numarası Meta deneyi kapsamında; mesaj iletilmedi',
  131000: 'Meta bilinmeyen bir hata bildirdi',
  131005: 'Erişim reddedildi; anahtarın izinlerini kontrol edin',
  131008: 'Zorunlu bir alan eksik',
  131009: 'Gönderilen alanlardan biri geçersiz (numara veya şablon değişkeni)',
  131016: 'WhatsApp hizmeti geçici olarak kullanılamıyor',
  131021: 'Gönderen ve alıcı numarası aynı',
  131026: 'Mesaj alıcıya iletilemedi (numara WhatsApp kullanmıyor olabilir)',
  131030: 'Alıcı numarası Meta test listesinde değil',
  131031: 'WhatsApp işletme hesabı kilitlendi',
  131042: 'WhatsApp işletme hesabında ödeme sorunu var',
  131045: 'Gönderici numara Meta’da kayıtlı değil',
  131047: '24 saatlik konuşma süresi geçti; onaylı şablon gerekir',
  131048: 'Spam sınırı nedeniyle gönderim kısıtlandı',
  131049: 'Meta bu mesajı iletmemeye karar verdi (alıcı sınırı)',
  131050: 'Alıcı işletme mesajlarını durdurmuş',
  131051: 'Desteklenmeyen mesaj türü',
  131052: 'Ek dosya indirilemedi',
  131053: 'Ek dosya yüklenemedi (biçim veya boyut uygun değil)',
  131056: 'Aynı alıcıya kısa sürede çok fazla mesaj gönderildi',
  131057: 'WhatsApp hesabı bakım modunda',
  132000: 'Şablon değişken sayısı şablonla uyuşmuyor',
  132001: 'Şablon bulunamadı (şablon adı veya dili hatalı ya da onaylanmamış)',
  132005: 'Şablon metni değişkenlerle birlikte çok uzun',
  132007: 'Şablon içeriği Meta politikasına takıldı',
  132012: 'Şablon değişkenlerinin biçimi şablonla uyuşmuyor',
  132015: 'Şablon düşük kalite nedeniyle duraklatıldı',
  132016: 'Şablon kalıcı olarak devre dışı bırakıldı',
  132068: 'Şablon akışı engellendi',
  133010: 'Gönderici numara WhatsApp Cloud API’ye kayıtlı değil',
  135000: 'Meta genel bir kullanıcı hatası bildirdi',
};
const LOCAL_ERRORS = {
  token: 'Kayıtlı Meta erişim anahtarı açılamadı; ayarlardan yeniden girin',
  timeout: 'Meta zamanında yanıt vermedi',
  network: 'Meta’ya bağlanılamadı',
  response: 'Meta beklenmeyen bir yanıt döndürdü',
  media: 'Ek dosya hazırlanamadı',
};

function deliveryError(error) {
  if (error?.meta) {
    const { code, subcode, text } = error.meta;
    return {
      code: String(code ?? error.status ?? '') + (subcode ? '/' + subcode : ''),
      message: META_ERRORS[code] || text || 'Meta isteği reddetti (HTTP ' + error.status + ')',
    };
  }
  const kind = error?.local || (error?.name === 'TimeoutError' ? 'timeout' : 'network');
  // Our own failures have no Meta code; the explanation alone is shown.
  return { code: '', message: LOCAL_ERRORS[kind] };
}

async function metaRejection(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {}
  const meta = body && typeof body.error === 'object' ? body.error : {};
  const text = [meta.error_user_title, meta.error_data?.details || meta.error_user_msg || meta.message]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(': ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return Object.assign(new Error('Meta API request rejected'), {
    status: response.status,
    meta: {
      code: Number.isFinite(Number(meta.code)) ? Number(meta.code) : null,
      subcode: Number.isFinite(Number(meta.error_subcode)) ? Number(meta.error_subcode) : null,
      text,
    },
  });
}

async function deliverWhatsApp(batch, { fetcher = fetch, renderMedia } = {}) {
  const { config, template, jobs, skipped = 0 } = batch;
  let accepted = 0,
    failed = 0;
  const errors = [];
  const noteError = (error) => {
    const found = deliveryError(error);
    const same = errors.find((row) => row.code === found.code && row.message === found.message);
    if (same) same.count++;
    else if (errors.length < 5) errors.push({ ...found, count: 1 });
  };
  if (!jobs.length) return { accepted, failed, skipped };
  let token;
  try {
    token = openToken(config.sealedToken);
  } catch {
    errors.push({ ...deliveryError({ local: 'token' }), count: jobs.length });
    return { accepted, failed: jobs.length, skipped, errors };
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
    if (!response.ok) throw await metaRejection(response);
    try {
      return await response.json();
    } catch {
      throw Object.assign(new Error('Meta response unreadable'), { local: 'response' });
    }
  };
  async function deliver(job) {
    try {
      const components = [];
      if (job.media) {
        let file;
        try {
          file = await renderMedia(job.media);
        } catch {
          throw Object.assign(new Error('Media render failed'), { local: 'media' });
        }
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', file.mime);
        form.append('file', new Blob([file.bytes], { type: file.mime }), file.name);
        const uploaded = await send('media', form, true);
        if (!uploaded.id) throw Object.assign(new Error('Meta media ID missing'), { local: 'response' });
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
      if (!result.messages?.[0]?.id)
        throw Object.assign(new Error('Meta message ID missing'), { local: 'response' });
      accepted++;
    } catch (error) {
      failed++;
      noteError(error);
    }
  }
  for (let i = 0; i < jobs.length; i += 10) await Promise.all(jobs.slice(i, i + 10).map(deliver));
  return { accepted, failed, skipped, ...(errors.length && { errors }) };
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
  deliveryError,
  unavailable,
};

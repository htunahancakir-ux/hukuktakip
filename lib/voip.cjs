const crypto = require('node:crypto');
const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: true });
const RESULTS = require('./voip-conversations.cjs').RESULTS;
const ACTIVE = new Set(['starting', 'ringing', 'answered', 'unknown']);
const STATUS = {
  starting: 'Arama başlatılıyor',
  ringing: 'Çalıyor',
  answered: 'Görüşülüyor',
  completed: 'Görüşüldü',
  unanswered: 'Ulaşılamadı',
  busy: 'Meşgul',
  failed: 'Başarısız',
  unknown: 'Durum doğrulanmalı',
};
function number(value) {
  let n = String(value || '').replace(/[\s()+.\-]/g, '');
  if (/^0[1-9]\d{9}$/.test(n)) n = '9' + n;
  if (/^[1-9]\d{9}$/.test(n)) n = '90' + n;
  return /^90[1-9]\d{9}$/.test(n) ? n : '';
}
function phones(doc) {
  const pairs = [
    ['Tel-1', doc.phone1],
    ['Tel-2', doc.phone2],
    ['Ref. Tel-1', doc.referencePhone1],
    ['Ref. Tel-2', doc.referencePhone2],
    ['Ofis Tel-1', doc.officePhone1],
    ['Ofis Tel-2', doc.officePhone2],
    ...(doc.additionalPhones || []).map((p, i) => ['Ek Telefon ' + (i + 1), p]),
  ];
  const seen = new Set();
  return pairs.flatMap(([label, value]) => {
    const phone = number(value);
    if (!phone || seen.has(phone)) return [];
    seen.add(phone);
    return [{ label, phone }];
  });
}
function encryptionKey() {
  const raw =
    process.env.VOIP_ENCRYPTION_KEY ||
    process.env.AI_ENCRYPTION_KEY ||
    process.env.BACKUP_ENCRYPTION_KEY ||
    '';
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw fail(503, 'Sunucuda VOIP_ENCRYPTION_KEY tanımlanmalı (64 haneli hex anahtar).');
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'hanhukuk-voip-v1', 32),
  );
}
function seal(value) {
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]).toString('base64');
}
function unseal(value) {
  const b = Buffer.from(value || '', 'base64');
  if (b.length < 29) throw fail(503, 'VoIP API anahtarı tanımlanmalı.');
  const c = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), b.subarray(0, 12));
  c.setAuthTag(b.subarray(-16));
  return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString('utf8');
}
function webphoneUrl(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      u.search ||
      u.hash ||
      !['bulutsantralim.com', 'bulutsantralim.net', 'verimor.com.tr'].some(
        (h) => u.hostname === h || u.hostname.endsWith('.' + h),
      )
    )
      throw Error();
    return u.href;
  } catch {
    throw fail(400, 'Web telefonu adresi Verimor’a ait, HTTPS ve tokensız bir adres olmalı.');
  }
}
const providers = {
  verimor: {
    name: 'Verimor',
    async request(config, endpoint, params = {}, method = 'GET', fetcher = fetch) {
      const url = new URL(endpoint, 'https://api.bulutsantralim.com/');
      url.searchParams.set('key', unseal(config.sealedKey));
      const jsonPost = endpoint === '/originate' && method === 'POST';
      if (!jsonPost) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      let response;
      try {
        response = await fetcher(url.href, {
          method,
          ...(jsonPost
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }
            : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw fail(
          504,
          'Verimor yanıtı alınamadı. Arama başladıysa tekrar başlatmayın; çağrı durumunu kontrol edin.',
        );
      }
      if (!response.ok) {
        const reason = (await response.text()).trim();
        const noChannel =
          response.status === 400 && endpoint.startsWith('/hangup/') && /^No such channel!?$/i.test(reason);
        const known = [
          [
            /ge[cç]ersiz (?:api )?anahtar|invalid (?:api[_ -]?)?key|invalid token|unauthorized/i,
            'Verimor API anahtarını kabul etmiyor. Santraldeki güncel API anahtarı yeniden kaydedilmeli.',
          ],
          [
            /ip.*(?:not allowed|not authorized|forbidden|denied)|(?:invalid|unauthorized|forbidden).*ip/i,
            'Verimor sunucunun IP adresine izin vermiyor. API erişim kısıtlarını kontrol edin.',
          ],
          [
            /cannot find employee for extension/i,
            'Verimor dahilisine personel hesabı atanmadığı için web telefonu açılamıyor.',
          ],
          [
            /^extension \d+ is not registered$/i,
            'Web telefonu santrale bağlı değil. Web telefonu penceresinde Hazır durumunu bekleyip tekrar deneyin.',
          ],
          [/^extension \d+ not found$/i, 'Kullanıcınızın dahilisi Verimor santralinde bulunamadı.'],
          [/^extension required$/i, 'Verimor arama isteğinde dahili bilgisi eksik.'],
          [/^destination required$/i, 'Verimor arama isteğinde hedef numara bilgisi eksik.'],
          [/^invalid destination: [\d+]+$/i, 'Verimor hedef telefon numarasını kabul etmedi.'],
          [/^invalid caller_id: [\d+]+$/i, 'Dış arama numarası Verimor santralinde tanımlı değil.'],
          [/^INVALID_JSON$/i, 'Verimor arama isteğinin JSON biçimini kabul etmedi.'],
        ].find(([pattern]) => pattern.test(reason))?.[1];
        const error = fail(
          502,
          known ||
            'Verimor isteği reddetti (HTTP ' +
              response.status +
              '). Dahili ve santral ayarlarını kontrol edin.',
        );
        error.noSuchChannel = noChannel;
        throw error;
      }
      return response.text();
    },
  },
};
function manager(user) {
  return ['ceo', 'admin'].includes(user?.role);
}
function listeningAllowed(user, call) {
  return manager(user) || user.voipDocuments?.includes(call.documentId);
}
function documentFor(state, user, id) {
  const doc = state.data['icrapro-v1'].docs.find((d) => d.id === id);
  if (!doc) throw fail(404, 'Borçlu föyü bulunamadı.');
  // Calls follow the same file-assignment rule as conversation entry.
  if (!manager(user) && (!user.staffId || doc.relatedStaff !== user.staffId))
    throw fail(403, 'Yalnızca size atanmış dosyadan arama yapabilirsiniz.');
  return doc;
}
function publicCall(call, user) {
  const { providerId, requestId, ...safe } = call;
  return {
    ...safe,
    canListen: !!listeningAllowed(user, call) && !!call.recordingPresent,
    statusLabel: STATUS[call.status] || call.status,
  };
}
// Seconds from a call record's "hh:mm:ss" talk time; undefined when the exchange reported none,
// so a missing value is never mistaken for a real zero.
function talkSeconds(value) {
  const parts = String(value ?? '')
    .trim()
    .split(':')
    .map(Number);
  return parts.length === 3 && parts.every(Number.isFinite)
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : undefined;
}
// Official Bulutsantralim call result codes (cagri-sonuc-kodlari.md) with their Turkish description,
// grouped by what they mean for the person we called: busy, given up by the caller before anyone
// answered, no answer, rejected, or a normal answered call.
const OUTCOMES = {
  USER_BUSY: ['busy', 'Meşgul'],
  ORIGINATOR_CANCEL: ['cancelled', 'Vazgeçildi'],
  NO_ANSWER: ['unanswered', 'Cevapsız'],
  ALLOTTED_TIMEOUT: ['unanswered', 'Cevapsız'],
  RECOVERY_ON_TIMER_EXPIRE: ['unanswered', 'Zamanaşımı'],
  NO_USER_RESPONSE: ['unanswered', 'Ulaşılamıyor'],
  CALL_REJECTED: ['rejected', 'Reddedildi'],
  INCOMING_CALL_BARRED: ['rejected', 'Reddedildi'],
  NORMAL_CLEARING: ['answered', 'Cevaplandı'],
  NORMAL_UNSPECIFIED: ['answered', 'Cevaplandı'],
};
// A call record's own "result" field carries the Turkish descriptions instead of the codes.
const OUTCOME_TEXT = Object.fromEntries(Object.values(OUTCOMES).map(([kind, text]) => [text, kind]));
function outcomeOf(value) {
  const text = String(value ?? '').trim(),
    code = text.toUpperCase();
  if (Object.hasOwn(OUTCOMES, code)) return OUTCOMES[code][0];
  return Object.hasOwn(OUTCOME_TEXT, text) ? OUTCOME_TEXT[text] : undefined;
}
function reasonOf(value) {
  const code = String(value ?? '')
    .trim()
    .toUpperCase();
  return Object.hasOwn(OUTCOMES, code) ? OUTCOMES[code][1] : '';
}
// A timestamp the exchange really filled in; an empty or zeroed stamp means it never happened.
const stamped = (value) => !!value && !/^(0000-00-00|1970-01-01)/.test(String(value));
// The exchange connects the extension first, so the call's own "answered" says nothing about the
// person we called. Their leg of the call record does.
function customerLeg(flow, phone) {
  const tail = String(phone ?? '')
    .replace(/\D/g, '')
    .slice(-10);
  if (!Array.isArray(flow) || tail.length < 10) return undefined;
  const leg = flow
    .filter(
      (item) =>
        String(item?.destination_number ?? '')
          .replace(/\D/g, '')
          .slice(-10) === tail,
    )
    .at(-1);
  return leg
    ? { answered: stamped(leg.answer_stamp), outcome: outcomeOf(leg.result), result: leg.result }
    : undefined;
}
// A call record (GET /cdrs/{uuid}: the call summary plus its per-leg call_flow) as the hangup event
// that updateEvent understands.
function cdrEvent(record, extra = {}) {
  const d = record?.cdr || {};
  return {
    event_type: 'hangup',
    answered: stamped(d.answer_stamp),
    recording_present: d.recording_present,
    hangup_cause: d.hangup_cause,
    failure_status: d.failure_status,
    result: d.result,
    sip_hangup_disposition: d.sip_hangup_disposition,
    call_flow: record?.call_flow ?? d.call_flow,
    duration: talkSeconds(d.talk_duration),
    ...extra,
  };
}
function updateEvent(call, event, config) {
  const external = number(event.outbound_caller_id_number || '');
  if (external && (!event.direction || event.direction === 'outbound')) {
    call.outboundNumber = external;
    if (config) {
      const lines = (config.outboundLines ||= {});
      lines[external] ||= Math.max(0, ...Object.values(lines).filter(Number.isInteger)) + 1;
      call.outboundLine = lines[external];
    }
  }
  if (event.event_type === 'ringing' && !call.endedAt && !call.answeredAt) call.status = 'ringing';
  if (event.event_type === 'answer') {
    call.answeredAt ||= new Date().toISOString();
    if (!call.endedAt) call.status = 'answered';
  }
  if (event.event_type === 'hangup') {
    call.endedAt ||= new Date().toISOString();
    const reported =
      event.answered === true || event.answered === 'true'
        ? true
        : event.answered === false || event.answered === 'false'
          ? false
          : null;
    const talked =
      event.duration === undefined || event.duration === null || String(event.duration).trim() === ''
        ? NaN
        : Number(event.duration);
    // What the exchange says about the person we called: the call's own cause and result and, in a
    // call record, the customer's leg.
    const leg = customerLeg(event.call_flow, call.phone);
    const outcomes = [outcomeOf(event.hangup_cause), outcomeOf(event.result), leg?.outcome];
    const busy =
      outcomes.includes('busy') ||
      /busy/i.test(event.hangup_cause || '') ||
      String(event.failure_status) === '486' ||
      (call.result === 'Meşgul' && call.resultBy === 'Santral' && !!call.resultAt);
    const gone = outcomes.find((kind) => ['cancelled', 'unanswered', 'rejected'].includes(kind));
    // The extension is connected first, so the exchange may call the call "answered" when nobody
    // talked. A reported zero talk time, a cause such as "Vazgeçildi" or a customer leg that never
    // answered is no conversation, so it is never "Görüşüldü". A real talk time, an earlier real
    // duration or a saved result is left untouched.
    const none = talked === 0 || !!gone || leg?.answered === false;
    const silent =
      (reported ?? !!call.answeredAt) &&
      !busy &&
      none &&
      !(talked > 0) &&
      !(call.duration > 0) &&
      !call.resultAt;
    const answered = (reported ?? !!call.answeredAt) && !silent;
    // What the exchange reported, kept so a surprising result can be explained afterwards.
    const text = (value) => (/^[\p{L}\p{N} _.:/-]{1,60}$/u.test(String(value ?? '')) ? String(value) : '');
    const by = ['caller', 'callee'].includes(event.sip_hangup_disposition)
      ? event.sip_hangup_disposition
      : '';
    call.providerEnd = {
      ...call.providerEnd,
      ...(reported === null ? {} : { answered: reported }),
      ...(Number.isFinite(talked) ? { talkSeconds: Math.min(86400, Math.floor(talked)) } : {}),
      ...(text(event.hangup_cause) ? { cause: text(event.hangup_cause) } : {}),
      ...(reasonOf(event.hangup_cause) ? { reason: reasonOf(event.hangup_cause) } : {}),
      ...(text(event.failure_status) ? { code: text(event.failure_status) } : {}),
      ...(text(event.result) ? { result: text(event.result) } : {}),
      ...(by ? { by } : {}),
      ...(leg
        ? { legAnswered: leg.answered, ...(text(leg.result) ? { legResult: text(leg.result) } : {}) }
        : {}),
    };
    call.status = busy ? 'busy' : answered ? 'completed' : 'unanswered';
    if ((busy || !answered) && !call.resultAt) {
      call.result = busy ? 'Meşgul' : 'Ulaşılamadı';
      const note = call.draftNote ?? call.note ?? '';
      const ended = call.hangupRequestedAt || call.cancelRequested || gone === 'cancelled';
      const automaticNote = busy
        ? 'Meşgul (santral bildirimi).'
        : ended
          ? 'Ulaşılamadı: arama görüşme olmadan sonlandırıldı (santral bildirimi).'
          : gone === 'rejected'
            ? 'Ulaşılamadı: arama reddedildi (santral bildirimi).'
            : gone === 'unanswered'
              ? 'Ulaşılamadı: arama cevaplanmadı (santral bildirimi).'
              : 'Ulaşılamadı (santral bildirimi).';
      call.note = note.trim() ? note.trim() + '\n' + automaticNote : automaticNote;
      call.resultAt = call.endedAt;
      call.resultBy = 'Santral';
      delete call.draftNote;
      delete call.draftUpdatedAt;
    }
    if (answered) call.answeredAt ||= call.createdAt;
    const duration = Number(event.duration);
    // A late zero must not erase a conversation time that is already recorded.
    if (Number.isFinite(duration) && duration >= 0 && !(duration === 0 && call.duration > 0))
      call.duration = Math.min(86400, Math.floor(duration));
  }
  if (event.recording_present === true || event.recording_present === 'true') call.recordingPresent = true;
}
function configure(saved, input, users) {
  if (input.provider !== 'verimor') throw fail(400, 'Bu sürümde Verimor bağlantısı kullanılabilir.');
  const next = {
    ...saved,
    provider: 'verimor',
    enabled: input.enabled === true,
    domainId: String(input.domainId || '').trim(),
    webphoneUrl: webphoneUrl(input.webphoneUrl),
    callerId: number(input.callerId),
    recentMinutes: Math.max(1, Math.min(10080, Number(input.recentMinutes) || 1440)),
  };
  if (!/^[\w.-]{0,100}$/.test(next.domainId)) throw fail(400, 'Santral kimliği geçersiz.');
  if (input.callerId && !next.callerId) throw fail(400, 'Dış numara geçersiz.');
  const key = String(input.apiKey || '').trim();
  if (key && (key.length > 512 || /[\u0000-\u0020]/.test(key))) throw fail(400, 'API anahtarı geçersiz.');
  if (input.clearKey) next.sealedKey = '';
  else if (key) next.sealedKey = seal(key);
  next.extensions = {};
  for (const [id, extension] of Object.entries(input.extensions ?? saved.extensions ?? {})) {
    if (!users.some((u) => u.id === id) || !extension) continue;
    if (!/^\d{2,8}$/.test(extension)) throw fail(400, 'Dahili numarası 2–8 rakam olmalı.');
    if (Object.values(next.extensions).includes(extension))
      throw fail(400, 'Aynı dahiliyi iki kullanıcıya atamayın.');
    next.extensions[id] = extension;
  }
  next.webhookSecret ||= crypto.randomBytes(32).toString('hex');
  if (next.enabled && (!next.sealedKey || !next.domainId))
    throw fail(400, 'Etkinleştirmek için API anahtarı ve santral kimliği gerekli.');
  return next;
}
function createVoipHandler({
  transaction,
  authenticatedUser,
  readBody,
  fetcher = fetch,
  recordings,
  transcriber,
  localTranscription = false,
  background = (p) => {
    void p;
  },
}) {
  const scoped = (work, scope = {}) => transaction((tx) => work(tx.state, tx.saveState), scope);
  const cronAuthorized = (req) =>
    [process.env.VOIP_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean).some((secret) => {
      const expected = Buffer.from('Bearer ' + secret),
        actual = Buffer.from(String(req.headers.authorization || ''));
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    });
  const transcription = require('./voip-transcription.cjs').createTranscription({
    scoped,
    recordings,
    transcriber,
    background,
  });
  if (localTranscription)
    setInterval(() => {
      void transcription.work();
    }, 30000).unref();
  const send = (res, value) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const recordingUrl = async (cfg, call) => {
    const value = (
      await providers.verimor.request(cfg, '/recording_url', { call_uuid: call.providerId }, 'POST', fetcher)
    ).trim();
    let u;
    try {
      u = new URL(value);
    } catch {
      throw fail(502, 'Kayıt adresi alınamadı.');
    }
    if (
      u.protocol !== 'https:' ||
      !['api.bulutsantralim.com', 'api.bulutsantralim.net'].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      throw fail(502, 'Kayıt adresi doğrulanamadı.');
    return u.href;
  };
  async function archive(id) {
    const run = (work) => scoped(work, { id });
    try {
      const info = await run((state, save) => {
        const c = (state.voipCalls || []).find((c) => c.id === id);
        if (
          !c ||
          c.archivedAt ||
          (!c.recordingPresent && c.status !== 'completed') ||
          !c.providerId ||
          (c.archiveStartedAt && Date.now() - Date.parse(c.archiveStartedAt) < 120000)
        )
          return null;
        c.archiveStartedAt = new Date().toISOString();
        c.archiveAttempt = (c.archiveAttempt || 0) + 1;
        save(state);
        return {
          cfg: state.voipConfig,
          call: structuredClone(c),
          hot: require('./voip-hot-cache.cjs').forCall(state, c),
        };
      });
      if (!info) return;
      if (!info.call.recordingPresent) {
        const data = JSON.parse(
          await providers.verimor.request(
            info.cfg,
            '/cdrs/' + encodeURIComponent(info.call.providerId),
            {},
            'GET',
            fetcher,
          ),
        );
        if (![true, 'true'].includes(data.cdr?.recording_present))
          throw Object.assign(Error('Kayıt henüz hazır değil.'), { recordingPending: true });
        await run((state, save) => {
          state.voipCalls.find((c) => c.id === id).recordingPresent = true;
          save(state);
        });
      }
      if (!recordings?.available) throw Error('Kalıcı ses arşivi için R2 bağlantısı gerekli.');
      const response = await fetcher(await recordingUrl(info.cfg, info.call), {
        redirect: 'error',
        signal: AbortSignal.timeout(40000),
      });
      if (!response.ok) throw Error('Ses dosyası henüz indirilemiyor.');
      if (Number(response.headers.get('content-length')) > 64 * 1024 * 1024)
        throw Error('Ses kaydı 64 MB sınırını aşıyor.');
      const chunks = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > 64 * 1024 * 1024) throw Error('Ses kaydı çok büyük.');
        chunks.push(Buffer.from(part));
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length < 16 ||
        !String(response.headers.get('content-type') || '').match(/audio\/(mpeg|mp3)|octet-stream/i) ||
        !(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224))
      )
        throw Error('Ses kaydı MP3 biçiminde doğrulanamadı.');
      await recordings.save(id, bytes, { cache: info.hot });
      await run((state, save) => {
        const c = state.voipCalls.find((c) => c.id === id);
        c.archivedAt = new Date().toISOString();
        const until = new Date(c.createdAt);
        until.setUTCFullYear(until.getUTCFullYear() + 5);
        c.retainUntil = until.toISOString();
        c.recordingSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        c.recordingBytes = bytes.length;
        delete c.archiveError;
        save(state);
      });
    } catch (e) {
      await run((state, save) => {
        const c = (state.voipCalls || []).find((c) => c.id === id);
        if (c) {
          c.archiveError = e.recordingPending
            ? 'Verimor bu çağrı için henüz ses kaydı sağlamadı. Kayıt oluşursa otomatik olarak yeniden kontrol edilecek.'
            : 'Ses kaydı arşivlenemedi. Yeniden deneyin; kalıcı depolama ayarlarını kontrol edin.';
          c.nextArchiveAt = new Date(
            Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(c.archiveAttempt || 0, 6)),
          ).toISOString();
          if (!c.recordingPresent && Date.now() - Date.parse(c.createdAt) > 86400000)
            c.recordingMissing = true;
          delete c.archiveStartedAt;
          save(state);
        }
      });
    }
  }
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/voip/')) return false;
    const path = url.pathname.slice(10);
    if (path === 'recover-call') {
      if (req.method !== 'POST' || !cronAuthorized(req)) throw fail(401, 'Yetkisiz istek.');
      const { id } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
      if (!/^[\w-]{8,100}$/.test(id || '')) throw fail(400, 'Çağrı kimliği geçersiz.');
      const current = await scoped(
        (state) => {
          const call = state.voipCalls.find((c) => c.id === id);
          if (!call || !call.cancelRequested || !call.providerId)
            throw fail(409, 'İptal bekleyen çağrı bulunamadı.');
          return { call: structuredClone(call), cfg: state.voipConfig };
        },
        { id },
      );
      let record;
      try {
        record = JSON.parse(
          await providers.verimor.request(
            current.cfg,
            '/cdrs/' + encodeURIComponent(current.call.providerId),
            {},
            'GET',
            fetcher,
          ),
        );
      } catch {
        /* A CDR may not be available until termination. */
      }
      let cdr = record?.cdr;
      if (!cdr?.end_stamp) {
        try {
          await providers.verimor.request(
            current.cfg,
            '/hangup/' + encodeURIComponent(current.call.providerId),
            {},
            'GET',
            fetcher,
          );
        } catch (error) {
          if (error.noSuchChannel) {
            await scoped(
              (state, save) => {
                const call = state.voipCalls.find((c) => c.id === id);
                if (ACTIVE.has(call.status)) {
                  call.status = 'failed';
                  call.closedConfirmedAt = new Date().toISOString();
                  call.endSource = 'provider-channel-missing';
                  call.endDetailsPending = true;
                  call.result = 'Diğer';
                  call.resultAt = call.closedConfirmedAt;
                  call.resultBy = 'Santral kontrolü';
                  call.note =
                    (call.draftNote || call.note || '') +
                    '\nKullanıcı iptal etti. Santral etkin kanal bulunmadığını doğruladı; gerçek kapanış saati ve süre alınamadı.';
                  delete call.providerError;
                  save(state);
                }
              },
              { id },
            );
            send(res, { ok: true, confirmed: true, detailsPending: true });
            return true;
          }
          if (!error.noSuchChannel) {
            await scoped(
              (state, save) => {
                const call = state.voipCalls.find((c) => c.id === id);
                if (ACTIVE.has(call.status)) {
                  call.status = 'unknown';
                  call.providerError = error.message;
                  save(state);
                }
              },
              { id },
            );
            throw error;
          }
        }
        record = JSON.parse(
          await providers.verimor.request(
            current.cfg,
            '/cdrs/' + encodeURIComponent(current.call.providerId),
            {},
            'GET',
            fetcher,
          ),
        );
        cdr = record.cdr;
      }
      if (!cdr?.end_stamp) throw fail(409, 'Santral kapanışı henüz doğrulanamadı.');
      await scoped(
        (state, save) => {
          const call = state.voipCalls.find((c) => c.id === id);
          updateEvent(call, cdrEvent(record));
          save(state);
        },
        { id },
      );
      background(archive(id));
      send(res, { ok: true, confirmed: true });
      return true;
    }
    if (path === 'transcription-cron') {
      if (!cronAuthorized(req)) throw fail(401, 'Yetkisiz istek.');
      const started = Date.now();
      let processed = 0;
      for (let i = 0; i < 3 && Date.now() - started < 20000; i++) {
        const result = await transcription.work();
        processed += result.processed;
        if (!result.processed) break;
      }
      send(res, { processed });
      return true;
    }
    if (path === 'watchdog') {
      if (!cronAuthorized(req)) throw fail(401, 'Yetkisiz istek.');
      const jobs = await scoped(
        (state, save) => {
          const now = Date.now();
          const due = (state.voipCalls || [])
            .filter(
              (c) =>
                c.browserManaged &&
                ACTIVE.has(c.status) &&
                now - Date.parse(c.browserSeenAt || c.createdAt) > 60000 &&
                (!c.watchdogAt || now - Date.parse(c.watchdogAt) > 60000),
            )
            .slice(0, 2);
          for (const c of due) c.watchdogAt = new Date(now).toISOString();
          if (due.length) save(state);
          return due.map((c) => c.id);
        },
        { watchdog: true },
      );
      for (const id of jobs) {
        const current = await scoped(
          (state) => ({ call: state.voipCalls.find((c) => c.id === id), cfg: state.voipConfig }),
          { id },
        );
        if (
          !current.call ||
          !ACTIVE.has(current.call.status) ||
          Date.now() - Date.parse(current.call.browserSeenAt || current.call.createdAt) <= 60000
        )
          continue;
        if (!current.call.providerId) continue;
        try {
          let record;
          try {
            record = JSON.parse(
              await providers.verimor.request(
                current.cfg,
                '/cdrs/' + encodeURIComponent(current.call.providerId),
                {},
                'GET',
                fetcher,
              ),
            );
          } catch {
            /* Closing does not depend on availability of CDR. */
          }
          const cdr = record?.cdr;
          let missing = false;
          if (!cdr?.end_stamp) {
            try {
              await providers.verimor.request(
                current.cfg,
                '/hangup/' + encodeURIComponent(current.call.providerId),
                {},
                'GET',
                fetcher,
              );
            } catch (error) {
              if (!error.noSuchChannel) throw error;
              missing = true;
            }
          }
          await scoped(
            (state, save) => {
              const c = state.voipCalls.find((c) => c.id === id);
              if (!ACTIVE.has(c.status)) return;
              c.cancelRequested = true;
              c.endSource = 'browser-disconnected';
              if (cdr?.end_stamp) {
                updateEvent(c, cdrEvent(record));
              } else if (missing) {
                c.status = 'failed';
                c.closedConfirmedAt = new Date().toISOString();
                c.endDetailsPending = true;
                c.note =
                  (c.draftNote || c.note || '') +
                  '\nTarayıcı bağlantısı kesildi. Santral etkin kanal bulunmadığını doğruladı; kapanış ayrıntıları alınamadı.';
              }
              delete c.providerError;
              save(state);
            },
            { id },
          );
          if (cdr?.recording_present) background(archive(id));
        } catch (error) {
          await scoped(
            (state, save) => {
              const c = state.voipCalls.find((c) => c.id === id);
              if (ACTIVE.has(c.status)) {
                c.status = 'unknown';
                c.providerError = error.message;
                save(state);
              }
            },
            { id },
          );
        }
      }
      send(res, { processed: jobs.length });
      return true;
    }
    if (path === 'cron') {
      if (!cronAuthorized(req)) throw fail(401, 'Yetkisiz istek.');
      const jobs = await scoped(
        (state) =>
          (state.voipCalls || [])
            .filter(
              (c) =>
                (c.recordingPresent || c.status === 'completed') &&
                !c.recordingMissing &&
                !c.archivedAt &&
                (!c.nextArchiveAt || Date.parse(c.nextArchiveAt) <= Date.now()),
            )
            .slice(0, 2)
            .map((c) => c.id),
        { jobs: true },
      );
      for (const id of jobs) await archive(id);
      send(res, { processed: jobs.length });
      return true;
    }
    if (path === 'webhook') {
      if (req.method !== 'POST') throw fail(405, 'Yöntem desteklenmiyor.');
      const raw = await readBody(req, 65536);
      let event;
      try {
        event =
          req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)
            ? req.body
            : String(req.headers['content-type'] || '').includes('application/json')
              ? JSON.parse(raw.toString() || '{}')
              : Object.fromEntries(new URLSearchParams(raw.toString()));
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error('Invalid webhook');
      } catch {
        throw fail(400, 'Geçersiz bildirim.');
      }
      const run = (work) => scoped(work, { webhook: event });
      const archiveId = await run((state, save) => {
        const cfg = state.voipConfig || {},
          token = url.searchParams.get('token') || '';
        if (
          !cfg.webhookSecret ||
          !/^[a-f0-9]{64}$/.test(token) ||
          !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cfg.webhookSecret))
        )
          throw fail(401, 'Bildirim anahtarı geçersiz.');
        if (
          !event.event_type &&
          !event.call_uuid &&
          Object.keys(event).every((k) => ['test', 'ping', 'verification'].includes(k))
        )
          return null;
        if (
          String(event.domain_id) !== cfg.domainId ||
          !['ringing', 'answer', 'hangup'].includes(event.event_type) ||
          !/^[\w-]{8,100}$/.test(event.call_uuid || '')
        ) {
          console.info(
            'VoIP webhook rejected',
            JSON.stringify({
              fields: Object.keys(event).filter((k) =>
                ['event_type', 'domain_id', 'call_uuid', 'test', 'ping', 'verification'].includes(k),
              ),
              type: ['ringing', 'answer', 'hangup'].includes(event.event_type) ? event.event_type : 'other',
              domainMatches: String(event.domain_id) === cfg.domainId,
              receivedDomainId: /^\d{1,20}$/.test(String(event.domain_id))
                ? String(event.domain_id)
                : 'unavailable',
              matchedCallId:
                (state.voipCalls || []).find((c) => c.providerId === event.call_uuid)?.id || null,
            }),
          );
          throw fail(400, 'Bildirim santrali veya çağrı bilgisi geçersiz.');
        }
        let call = (state.voipCalls || []).find((c) => c.providerId === event.call_uuid);
        if (!call)
          call = (state.voipCalls || []).find(
            (c) =>
              !c.providerId &&
              ACTIVE.has(c.status) &&
              c.extension === String(event.connected_user || event.dialed_user) &&
              c.phone === number(event.destination_number),
          );
        if (call) {
          call.providerId ||= event.call_uuid;
          updateEvent(call, event, cfg);
          save(state);
          return call.recordingPresent ? call.id : null;
        }
      });
      if (archiveId) background(archive(archiveId));
      send(res, { ok: true });
      return true;
    }
    const user = await authenticatedUser(req);
    if (user.role !== 'ceo' && user.activeBreak) throw fail(423, 'Önce molayı bitirin.');
    if (!['GET', 'POST', 'PUT'].includes(req.method)) throw fail(405, 'Yöntem desteklenmiyor.');
    if (user.role !== 'ceo' && user.readOnly && req.method !== 'GET')
      throw fail(403, 'Bu hesap salt okunurdur.');
    let input;
    try {
      input =
        req.method === 'GET'
          ? Object.fromEntries(url.searchParams)
          : JSON.parse((await readBody(req, 65536)).toString() || '{}');
    } catch (e) {
      if (e.status) throw e;
      throw fail(400, 'Geçersiz veri.');
    }
    const scope = {
      id: input.id,
      documentId: input.documentId,
      userId: user.id,
      phone: number(input.phone),
      requestId: input.requestId,
      cancelRequest: path === 'cancel-start',
      reserve: path === 'start',
      standalone: !input.documentId && (path === 'start' || path === 'calls'),
      users: ['config', 'permissions', 'extensions'].includes(path),
      permissions: path === 'permissions',
      permissionUserId: path === 'permissions' ? input.userId : null,
      configWrite: ['config', 'extensions'].includes(path) && req.method === 'PUT',
      fullHistory: path === 'history',
      ...(path === 'recordings' ? { list: input } : {}),
    };
    const run = (work) =>
      scoped((state, save) => {
        user.voipDocuments =
          state.voipAccessibleDocuments ||
          ((state.voipGrants || []).some((g) => g.userId === user.id && g.staffId === user.staffId)
            ? state.data['icrapro-v1'].docs.filter((d) => d.relatedStaff === user.staffId).map((d) => d.id)
            : []);
        return work(state, save);
      }, scope);
    if (path === 'transcriptions' && req.method === 'POST') {
      if (!manager(user)) throw fail(403, 'Toplu yazıya çevirme için yönetici yetkisi gerekli.');
      send(res, await transcription.enqueue(input, user));
      return true;
    }
    if (path === 'transcript' && req.method === 'GET') {
      const call = await run((state) => state.voipCalls.find((c) => c.id === input.id));
      if (!call) throw fail(404, 'Görüşme kaydı bulunamadı.');
      if (!listeningAllowed(user, call)) throw fail(403, 'Bu dosyanın AI metnini görüntüleme yetkiniz yok.');
      send(res, await transcription.read(call));
      return true;
    }
    if (path === 'history' && req.method === 'GET') {
      const result = await run((state) => {
        const doc = documentFor(state, user, input.documentId);
        const calls = state.voipCalls.filter((c) => c.documentId === doc.id);
        let rows = require('./voip-conversations.cjs').merge(doc.conversations, calls);
        if (input.result) rows = rows.filter((r) => r.result === input.result);
        rows.sort(
          (a, b) =>
            (b.date + b.time).localeCompare(a.date + a.time) || String(b.id).localeCompare(String(a.id)),
        );
        const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
        const map = new Map(calls.map((c) => [c.id, c]));
        return {
          results: RESULTS,
          total: rows.length,
          rows: rows.slice(offset, offset + 50).map((r) => ({
            ...r,
            ...(r.voipCallId ? { call: publicCall(map.get(r.voipCallId), user) } : {}),
          })),
        };
      });
      send(res, result);
      return true;
    }
    if (path === 'extensions') {
      if (!manager(user)) throw fail(403, 'Dahili numaralarını yalnızca CEO ve yöneticiler değiştirebilir.');
      if (!['GET', 'PUT'].includes(req.method)) throw fail(405, 'Yöntem desteklenmiyor.');
      const result = await run((state, save) => {
        if (req.method === 'PUT') {
          if (Object.keys(input).some((k) => !['userId', 'extension'].includes(k)))
            throw fail(400, 'Bu alandan yalnızca dahili eşleştirmesi değiştirilebilir.');
          const target = state.users.find((u) => u.id === input.userId && u.active);
          if (!target) throw fail(400, 'Aktif kullanıcı seçin.');
          if (typeof input.extension !== 'string') throw fail(400, 'Geçerli dahili numarası girin.');
          const extension = input.extension.trim();
          if (extension && !/^\d{2,8}$/.test(extension)) throw fail(400, 'Dahili numarası 2–8 rakam olmalı.');
          const cfg = (state.voipConfig ||= {}),
            extensions = { ...cfg.extensions };
          if (
            extension &&
            Object.entries(extensions).some(([id, value]) => id !== target.id && value === extension)
          )
            throw fail(409, 'Bu dahili başka bir kullanıcıya atanmış.');
          if (extension) extensions[target.id] = extension;
          else delete extensions[target.id];
          cfg.extensions = extensions;
          cfg.extensionUpdatedAt = new Date().toISOString();
          cfg.extensionUpdatedBy = user.id;
          save(state);
        }
        return {
          users: state.users
            .filter((u) => u.active)
            .map((u) => ({
              id: u.id,
              name: u.name,
              username: u.username,
              role: u.role,
              extension: state.voipConfig?.extensions?.[u.id] || '',
            })),
        };
      });
      send(res, result);
      return true;
    }
    if (path === 'permissions') {
      if (!manager(user)) throw fail(403, 'Dinleme yetkisini CEO ve yönetici belirler.');
      if (!['GET', 'PUT'].includes(req.method)) throw fail(405, 'Yöntem desteklenmiyor.');
      const result = await run((state, save) => {
        state.voipGrants ||= [];
        if (req.method === 'PUT') {
          const target = state.users.find((u) => u.id === input.userId && u.active && u.staffId);
          if (!target) throw fail(400, 'Personel hesabı ve dosya sorumlusu eşleştirmesi gerekli.');
          state.voipGrants = state.voipGrants.filter((g) => g.userId !== target.id);
          if (input.allowed === true)
            state.voipGrants.push({
              userId: target.id,
              staffId: target.staffId,
              grantedBy: user.id,
              grantedByName: user.name,
              grantedAt: new Date().toISOString(),
            });
          save(state);
        }
        return {
          users: state.users
            .filter((u) => u.active && !manager(u))
            .map((u) => ({
              id: u.id,
              name: u.name,
              assigned: !!u.staffId,
              allowed: state.voipGrants.some((g) => g.userId === u.id && g.staffId === u.staffId),
            })),
        };
      });
      send(res, result);
      return true;
    }
    if (['recordings', 'media'].includes(path)) {
      if (path === 'recordings' && !manager(user))
        throw fail(403, 'Ses arşivine yalnızca CEO ve yönetici erişebilir.');
      if (req.method !== 'GET') throw fail(405, 'Yöntem desteklenmiyor.');
      if (path === 'recordings') {
        const sort = require('./voip-sorting.cjs').sorting(input);
        if (input.status && !Object.hasOwn(STATUS, input.status) && input.status !== 'active')
          throw fail(400, 'Geçersiz çağrı durumu.');
        if (input.result && !RESULTS.includes(input.result)) throw fail(400, 'Geçersiz görüşme sonucu.');
        const value = await run((state) => {
          let calls = state.voipPaged ? state.voipCalls : [...(state.voipCalls || [])].sort(sort.compare);
          const q = String(input.q || '').toLocaleLowerCase('tr');
          if (q)
            calls = calls.filter((c) =>
              [c.clientName, c.documentNumber, c.debtorName, c.phone, c.staffName, c.result]
                .join(' ')
                .toLocaleLowerCase('tr')
                .includes(q),
            );
          if (input.date)
            calls = calls.filter(
              (c) =>
                new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(
                  new Date(c.createdAt),
                ) === input.date,
            );
          if (input.status)
            calls = calls.filter((c) =>
              input.status === 'active' ? ACTIVE.has(c.status) : c.status === input.status,
            );
          if (input.result) calls = calls.filter((c) => c.result === input.result);
          const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
          return {
            total: state.voipTotal ?? calls.length,
            calls: (state.voipPaged ? calls : calls.slice(offset, offset + 50)).map((c) =>
              publicCall(c, user),
            ),
            results: RESULTS,
            statuses: STATUS,
          };
        });
        send(res, value);
        return true;
      }
      const call = await run((state) => {
        const c = (state.voipCalls || []).find((c) => c.id === input.id);
        return c ? { ...c, cacheHot: require('./voip-hot-cache.cjs').forCall(state, c) } : null;
      });
      if (call && (!listeningAllowed(user, call) || (input.download === '1' && !manager(user))))
        throw fail(403, 'Bu dosyanın ses kayıtlarını dinleme yetkiniz yok.');
      if (!call?.archivedAt) throw fail(404, 'Ses kaydı henüz arşivde değil.');
      const bytes = await recordings.read(call.id, { cache: call.cacheHot }),
        filename = require('./voip-recordings.cjs').filename(call);
      let first = 0,
        last = bytes.length - 1,
        status = 200;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) throw fail(416, 'Geçersiz ses aralığı.');
        if (match[1]) {
          first = Number(match[1]);
          if (match[2]) last = Math.min(last, Number(match[2]));
        } else first = Math.max(0, bytes.length - Number(match[2]));
        if (first > last || first >= bytes.length) throw fail(416, 'Geçersiz ses aralığı.');
        status = 206;
      }
      const portion = bytes.subarray(first, last + 1);
      res.writeHead(status, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        'Content-Length': portion.length,
        ...(status === 206 ? { 'Content-Range': `bytes ${first}-${last}/${bytes.length}` } : {}),
        'Content-Disposition': `${input.download === '1' ? 'attachment' : 'inline'}; filename="gorusme.mp3"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      const { Readable } = require('node:stream');
      await require('node:stream/promises').pipeline(
        Readable.from(
          (function* () {
            for (let i = 0; i < portion.length; i += 65536) yield portion.subarray(i, i + 65536);
          })(),
        ),
        res,
      );
      return true;
    }
    if (path === 'config') {
      if (user.role !== 'ceo') throw fail(403, 'VoIP ayarlarını yalnızca CEO yönetebilir.');
      if (!['GET', 'PUT'].includes(req.method)) throw fail(405, 'Yöntem desteklenmiyor.');
      const value = await run((state, save) => {
        if (req.method === 'PUT') {
          state.voipConfig = configure(state.voipConfig || {}, input, state.users);
          save(state);
        }
        const { sealedKey, webhookSecret, ...config } = state.voipConfig || {};
        let encryptionReady = true;
        try {
          encryptionKey();
        } catch {
          encryptionReady = false;
        }
        return {
          provider: 'verimor',
          recentMinutes: 1440,
          ...config,
          archiveReady: !!recordings?.available,
          apiKeySaved: !!sealedKey,
          encryptionReady,
          webhookPath: webhookSecret ? '/api/voip/webhook?token=' + webhookSecret : '',
          providers: Object.entries(providers).map(([id, p]) => ({ id, name: p.name })),
          users: state.users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })),
        };
      });
      send(res, value);
      return true;
    }
    if (path === 'calls' && req.method === 'GET') {
      const value = await run((state) => {
        const doc = input.documentId ? documentFor(state, user, input.documentId) : null,
          cfg = state.voipConfig || {},
          list = doc ? phones(doc) : [],
          numbers = new Set(list.map((p) => p.phone));
        if (!doc && number(input.phone)) numbers.add(number(input.phone));
        const calls = (state.voipCalls || [])
          .filter(
            (c) =>
              numbers.has(c.phone) ||
              (doc && c.documentId === doc.id) ||
              (!doc && c.userId === user.id && !c.documentId),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          enabled: !!cfg.enabled,
          extension: cfg.extensions?.[user.id] || '',
          webphone: !!cfg.webphoneUrl,
          recentMinutes: cfg.recentMinutes || 1440,
          phones: list,
          calls: calls.map((c) =>
            !doc && !manager(user) && c.userId !== user.id
              ? {
                  phone: c.phone,
                  createdAt: c.createdAt,
                  staffName: c.staffName,
                  duration: c.duration,
                  status: c.status,
                  statusLabel: STATUS[c.status] || c.status,
                  result: c.result,
                }
              : publicCall(c, user),
          ),
          active: (state.voipCalls || [])
            .filter((c) => ACTIVE.has(c.status) && c.userId === user.id)
            .map((c) => publicCall(c, user)),
          results: RESULTS,
        };
      });
      send(res, value);
      return true;
    }
    if (path === 'webphone' && req.method === 'POST') {
      const cfg = await run((state) => state.voipConfig || {}),
        extension = cfg.extensions?.[user.id];
      if (!cfg.enabled || !extension || !cfg.webphoneUrl)
        throw fail(400, 'VoIP ayarlarında dahili ve web telefonu adresini tamamlayın.');
      const token = (
        await providers.verimor.request(cfg, '/webphone_tokens', { extension }, 'POST', fetcher)
      ).trim();
      if (!/^W[\w-]{20,100}$/.test(token)) throw fail(502, 'Web telefonu oturumu açılamadı.');
      const dest = new URL(cfg.webphoneUrl);
      dest.searchParams.set('token', token);
      send(res, { url: dest.href });
      return true;
    }
    if (path === 'cancel-start' && req.method === 'POST') {
      if (!/^[\w-]{16,80}$/.test(input.requestId || '')) throw fail(400, 'İstek kimliği geçersiz.');
      const pending = await run((state, save) => {
        const call = state.voipCalls.find((c) => c.userId === user.id && c.requestId === input.requestId);
        if (!call) throw fail(409, 'Arama isteği henüz kaydedilmedi.');
        if (ACTIVE.has(call.status)) {
          call.cancelRequested = true;
          save(state);
        }
        return { call: structuredClone(call), cfg: state.voipConfig };
      });
      if (pending.call.providerId && ACTIVE.has(pending.call.status)) {
        try {
          await providers.verimor.request(
            pending.cfg,
            '/hangup/' + encodeURIComponent(pending.call.providerId),
            {},
            'GET',
            fetcher,
          );
        } catch (error) {
          if (!error.noSuchChannel) throw error;
        }
      }
      send(res, { ok: true });
      return true;
    }
    if (path === 'start' && req.method === 'POST') {
      if (!/^[\w-]{16,80}$/.test(input.requestId || '')) throw fail(400, 'İstek kimliği geçersiz.');
      const reservation = await run((state, save) => {
        const cfg = state.voipConfig || {},
          doc = input.documentId ? documentFor(state, user, input.documentId) : null,
          phone = number(input.phone);
        if (!cfg.enabled || !cfg.sealedKey || !cfg.extensions?.[user.id])
          throw fail(400, 'VoIP bağlantısı ve kullanıcı dahilisi ayarlanmalı.');
        if (!phone) throw fail(400, 'Geçerli bir Türkiye telefon numarası girin.');
        if (doc && !phones(doc).some((p) => p.phone === phone))
          throw fail(400, 'Numara bu föyde kayıtlı değil.');
        const calls = (state.voipCalls ||= []),
          old = calls.find((c) => c.requestId === input.requestId && c.userId === user.id);
        if (old) return { call: publicCall(old, user), existing: true };
        const active = calls.find((c) => ACTIVE.has(c.status) && (c.phone === phone || c.userId === user.id));
        if (active)
          throw fail(
            409,
            active.staffName + ' tarafından başlatılan arama sürüyor veya durumu doğrulanmalı.',
          );
        const last = calls
          .filter((c) => c.phone === phone)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (
          last &&
          !input.confirmRecent &&
          Date.now() - Date.parse(last.createdAt) < (cfg.recentMinutes || 1440) * 60000 &&
          !['unanswered', 'busy', 'failed'].includes(last.status)
        )
          throw fail(
            409,
            'Bu numara yakın zamanda arandı. Son görüşmeyi inceleyip tekrar aramayı onaylayın.',
          );
        const call = {
          id: crypto.randomUUID(),
          requestId: input.requestId,
          provider: cfg.provider,
          documentId: doc?.id || '',
          documentNumber: doc?.number || '',
          clientName: state.data['icrapro-v1'].clients.find((c) => c.id === doc?.client)?.name || '',
          debtorName: doc?.debtor || '',
          phone,
          userId: user.id,
          staffName: user.name,
          extension: cfg.extensions[user.id],
          createdAt: new Date().toISOString(),
          browserManaged: input.browserManaged === true && !!cfg.webphoneUrl,
          browserSeenAt: new Date().toISOString(),
          status: 'starting',
          duration: 0,
          result: '',
          note: '',
          recordingPresent: false,
        };
        require('./test-records.cjs').markRecord(null, call, user, 'note');
        calls.push(call);
        save(state);
        return { id: call.id, cfg, call };
      });
      if (reservation.existing) {
        send(res, reservation);
        return true;
      }
      const canceledBeforeDial = await run((state, save) => {
        const c = state.voipCalls.find((c) => c.id === reservation.id);
        if (!c.cancelRequested) return null;
        c.status = 'failed';
        c.endedAt = new Date().toISOString();
        save(state);
        return publicCall(c, user);
      });
      if (canceledBeforeDial) {
        send(res, { call: canceledBeforeDial });
        return true;
      }
      let providerId, error;
      try {
        providerId = (
          await providers.verimor.request(
            reservation.cfg,
            '/originate',
            {
              extension: reservation.call.extension,
              destination: reservation.call.phone,
              ...(reservation.cfg.callerId ? { caller_id: reservation.cfg.callerId } : {}),
              manual_answer: false,
            },
            'GET',
            fetcher,
          )
        ).trim();
        if (!/^[\w-]{8,100}$/.test(providerId))
          throw fail(504, 'Arama kimliği doğrulanamadı. Santralden kontrol edin.');
      } catch (e) {
        error = e;
      }
      const call = await run((state, save) => {
        const c = state.voipCalls.find((c) => c.id === reservation.id);
        if (providerId) c.providerId ||= providerId;
        providerId ||= c.providerId;
        if (c.status === 'starting')
          c.status = error ? (error.status === 502 ? 'failed' : 'unknown') : 'ringing';
        if (c.status === 'failed') c.endedAt = new Date().toISOString();
        if (error) c.providerError = error.message;
        save(state);
        return publicCall(c, user);
      });
      if (call.cancelRequested && providerId && ACTIVE.has(call.status)) {
        try {
          await providers.verimor.request(
            reservation.cfg,
            '/hangup/' + encodeURIComponent(providerId),
            {},
            'GET',
            fetcher,
          );
        } catch (error) {
          if (!error.noSuchChannel) call.cancelError = error.message;
        }
      }
      if (error) throw error;
      send(res, { call });
      return true;
    }
    if (
      ['heartbeat', 'draft', 'result', 'hangup', 'sync', 'recording', 'archive', 'mute'].includes(path) &&
      req.method === 'POST'
    ) {
      const current = await run((state) => {
        const c = (state.voipCalls || []).find((c) => c.id === input.id);
        if (!c) throw fail(404, 'Arama kaydı bulunamadı.');
        if (path === 'recording') {
          if (!listeningAllowed(user, c))
            throw fail(403, 'Bu dosyanın ses kayıtlarını dinleme yetkiniz yok.');
        } else if (path === 'archive') {
          if (!manager(user)) throw fail(403, 'Arşiv işlemi için yönetici yetkisi gerekli.');
        } else if (!manager(user) && c.userId !== user.id)
          throw fail(403, 'Bu arama üzerinde işlem yetkiniz yok.');
        return { call: structuredClone(c), cfg: state.voipConfig || {} };
      });
      if (path === 'heartbeat') {
        if (current.call.userId !== user.id) throw fail(403, 'Bu arama size ait değil.');
        await run((state, save) => {
          const c = state.voipCalls.find((c) => c.id === input.id);
          if (c.browserManaged && ACTIVE.has(c.status)) {
            c.browserSeenAt = new Date().toISOString();
            save(state);
          }
        });
        send(res, { ok: true });
        return true;
      }
      if (path === 'archive') {
        await archive(current.call.id);
        send(res, { ok: true });
        return true;
      }
      if (path === 'draft') {
        if (typeof input.note !== 'string' || input.note.length > 3000)
          throw fail(400, 'Görüşme notu en fazla 3000 karakter olabilir.');
        await run((state, save) => {
          const c = state.voipCalls.find((c) => c.id === input.id);
          if (c.resultAt) throw fail(409, 'Görüşme sonucu zaten kaydedildi; geçmişten düzenleyebilirsiniz.');
          c.draftNote = input.note;
          c.draftUpdatedAt = new Date().toISOString();
          save(state);
        });
        send(res, { ok: true });
        return true;
      }
      if (path === 'result') {
        if (current.call.resultAt)
          throw fail(409, 'Kaydedilmiş görüşmeyi borçlu föyünün görüşme akışından düzenleyin.');
        if (['Tekrar Aranacak', 'Ödeme Sözü Alındı'].includes(input.result))
          throw fail(
            409,
            'Bu sonuç için arama planını veya ödeme sözü bilgilerini borçlu görüşme formundan tamamlayın.',
          );
        if (!RESULTS.includes(input.result) || typeof input.note !== 'string' || input.note.length > 3000)
          throw fail(400, 'Görüşme sonucu ve en fazla 3000 karakter not girin.');
        await run((state, save) => {
          const c = state.voipCalls.find((c) => c.id === input.id);
          if (ACTIVE.has(c.status)) throw fail(409, 'Önce çağrının bittiğini doğrulayın.');
          c.result = input.result;
          c.note = input.note.trim();
          c.resultBy = user.name;
          c.resultAt = new Date().toISOString();
          delete c.draftNote;
          delete c.draftUpdatedAt;
          save(state);
        });
        send(res, { ok: true });
        return true;
      }
      if (!current.call.providerId)
        throw fail(409, 'Çağrı kimliği henüz alınamadı; santralden kontrol edin.');
      if (path === 'mute') {
        if (!ACTIVE.has(current.call.status)) throw fail(409, 'Görüşme sona erdi.');
        if (typeof input.muted !== 'boolean') throw fail(400, 'Sessiz durumu geçersiz.');
        await providers.verimor.request(
          current.cfg,
          '/mute/' + encodeURIComponent(current.call.providerId),
          { state: input.muted ? 'on' : 'off' },
          'GET',
          fetcher,
        );
        await run((state, save) => {
          state.voipCalls.find((c) => c.id === input.id).muted = input.muted;
          save(state);
        });
        send(res, { ok: true, muted: input.muted });
        return true;
      }
      if (path === 'recording') {
        if (!current.call.recordingPresent) throw fail(404, 'Bu aramanın ses kaydı henüz hazır değil.');
        if (!current.call.archivedAt) await archive(current.call.id);
        const ready = await run((state) => state.voipCalls.find((c) => c.id === input.id).archivedAt);
        if (!ready) throw fail(409, 'Ses kaydı henüz arşivlenemedi. Yeniden deneyin.');
        send(res, { url: '/api/voip/media?id=' + encodeURIComponent(input.id) });
        return true;
      }
      if (path === 'hangup') {
        // The exchange reports the result but not who ended the call; remember that it was us.
        await run((state, save) => {
          const c = state.voipCalls.find((c) => c.id === input.id);
          if (c && ACTIVE.has(c.status) && !c.hangupRequestedAt) {
            c.hangupRequestedAt = new Date().toISOString();
            save(state);
          }
        });
        try {
          await providers.verimor.request(
            current.cfg,
            '/hangup/' + encodeURIComponent(current.call.providerId),
            {},
            'GET',
            fetcher,
          );
          send(res, { ok: true });
          return true;
        } catch (error) {
          if (!error.noSuchChannel) throw error;
          // A closed channel is not a connection-settings error. Verify the
          // completed CDR before unlocking this call or allowing another one.
        }
      }
      const data = JSON.parse(
        await providers.verimor.request(
          current.cfg,
          '/cdrs/' + encodeURIComponent(current.call.providerId),
          {},
          'GET',
          fetcher,
        ),
      );
      await run((state, save) => {
        const c = state.voipCalls.find((c) => c.id === input.id),
          d = data.cdr;
        if (!d?.end_stamp) throw fail(409, 'Çağrı henüz tamamlanmadı veya kayıt hazır değil.');
        updateEvent(
          c,
          cdrEvent(data, {
            outbound_caller_id_number:
              d.outbound_caller_id_number ||
              (/^outbound$|^Giden/i.test(d.direction || '') ? d.caller_id_number : ''),
          }),
          state.voipConfig,
        );
        save(state);
      });
      background(archive(input.id));
      send(res, { ok: true });
      return true;
    }
    throw fail(404, 'VoIP işlemi bulunamadı.');
  };
}
module.exports = { createVoipHandler, number, phones, configure, RESULTS, STATUS, updateEvent };

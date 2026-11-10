const crypto = require('node:crypto');
const ai = require('./ai-settings.cjs');
const fail = (message) => Object.assign(Error(message), { status: 400, publicMessage: true });
function settings(config = {}) {
  if (config.transcriptionEnabled === false) throw fail('AI ayarlarında ses yazıya çevirme kapalı.');
  const runtime = ai.runtimeConfig({ ...config, enabled: true });
  if (!runtime)
    throw fail('AI sağlayıcısının kimlik bilgileri hazır değil. Yapay Zeka ayarlarını tamamlayın.');
  const model = config.transcriptionModel || 'openai/gpt-transcribe';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(model)) throw fail('Ses çözümleme modeli geçersiz.');
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([runtime.provider, model, config.sealedApiKey, config.customProviders]))
    .digest('hex');
  return { ...runtime, model, hash };
}
function chunks(bytes, max = 20 * 1024 * 1024) {
  if (bytes.length <= max) return [bytes];
  let offset = 0;
  if (bytes.subarray(0, 3).toString() === 'ID3')
    offset =
      10 +
      ((bytes[6] & 127) * 2097152 + (bytes[7] & 127) * 16384 + (bytes[8] & 127) * 128 + (bytes[9] & 127)) +
      (bytes[5] & 16 ? 10 : 0);
  const result = [];
  let start = offset;
  while (offset + 4 <= bytes.length) {
    const a = bytes[offset],
      b = bytes[offset + 1],
      c = bytes[offset + 2];
    if (a !== 255 || (b & 224) !== 224) {
      if (bytes.length - offset <= 128) break;
      throw fail('Uzun ses dosyasında MP3 kareleri okunamadı; kayıt yeniden kontrol edilmeli.');
    }
    const version = (b >> 3) & 3,
      layer = (b >> 1) & 3,
      rate = (c >> 4) & 15,
      sample = (c >> 2) & 3;
    if (version === 1 || layer !== 1 || rate === 0 || rate === 15 || sample === 3)
      throw fail('Bu MP3 dosyası kayıpsız parçalara ayrılamadı.');
    const bitrate = (
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    )[rate];
    const hz = [44100, 48000, 32000][sample] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / hz) + ((c >> 1) & 1);
    if (offset + length > bytes.length) throw fail('MP3 ses dosyası eksik.');
    if (offset + length - start > max) {
      result.push(bytes.subarray(start, offset));
      start = offset;
    }
    offset += length;
  }
  if (offset > start) result.push(bytes.subarray(start, offset));
  if (!result.length) throw fail('Ses parçalara ayrılamadı.');
  return result;
}
async function transcribe(audio, runtime, { fetcher = fetch, signal } = {}) {
  if (runtime.provider === 'vercel-ai-gateway') {
    const { transcribe, createGateway } = await import('ai');
    const gateway = createGateway({ apiKey: runtime.authorization.slice(7), fetch: fetcher });
    const result = await transcribe({
      model: gateway.transcriptionModel(runtime.model),
      audio,
      maxRetries: 0,
      abortSignal: signal,
    });
    if (!result.text?.trim()) throw fail('AI boş transkript döndürdü.');
    return { text: result.text, language: result.language };
  }
  const endpoint = runtime.endpoint.replace(/\/(responses|chat\/completions)\/?$/, '/audio/transcriptions');
  const data = new FormData();
  data.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'gorusme.mp3');
  data.append(
    'model',
    runtime.provider === 'openai' ? runtime.model.replace(/^openai\//, '') : runtime.model,
  );
  data.append('response_format', 'json');
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { Authorization: runtime.authorization },
    body: data,
    signal,
    redirect: 'error',
  });
  if (!response.ok)
    throw fail(
      'Ses çözümleme sağlayıcısı isteği reddetti (HTTP ' +
        response.status +
        '). Model ve ses API desteğini kontrol edin.',
    );
  const result = await response.json();
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 1000000)
    throw fail('AI geçerli bir transkript döndürmedi.');
  return { text: result.text, language: result.language };
}
function createTranscription({ scoped, recordings, transcriber = transcribe, background }) {
  let running = false;
  async function work() {
    if (running) return { processed: 0 };
    running = true;
    let claimed;
    try {
      claimed = await scoped(
        (state, save) => {
          const calls = state.voipCalls || [];
          if (
            calls.some(
              (c) =>
                c.transcription?.status === 'processing' &&
                Date.parse(c.transcription.leaseUntil) > Date.now(),
            )
          )
            return null;
          const call = calls.find(
            (c) =>
              c.archivedAt &&
              (c.transcription?.status === 'queued' ||
                (c.transcription?.status === 'processing' &&
                  Date.parse(c.transcription.leaseUntil) <= Date.now())),
          );
          if (!call) return null;
          if (call.transcription.status === 'processing') {
            call.transcription.status = 'failed';
            call.transcription.error = 'İşlem kesildi. Yeniden denemeyi seçebilirsiniz.';
            save(state);
            return null;
          }
          const job = call.transcription;
          let runtime;
          try {
            runtime = settings(state.aiConfig);
            if (runtime.hash !== job.configHash)
              throw fail('AI ayarları değişti. Kaydı yeniden kuyruğa alın.');
          } catch (error) {
            job.status = 'failed';
            job.error = error.message;
            save(state);
            return null;
          }
          job.status = 'processing';
          job.claim = crypto.randomUUID();
          job.leaseUntil = new Date(Date.now() + 120000).toISOString();
          save(state);
          return {
            call: structuredClone(call),
            runtime,
            hot: require('./voip-hot-cache.cjs').forCall(state, call),
          };
        },
        { transcriptionJobs: true, aiConfig: true },
      );
      if (!claimed) return { processed: 0 };
      const call = claimed.call,
        job = call.transcription;
      const audio = await recordings.read(call.id, { cache: claimed.hot });
      const parts = chunks(audio);
      const done = job.parts || [];
      const result = await transcriber(parts[done.length], claimed.runtime, {
        signal: AbortSignal.timeout(75000),
      });
      if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 1000000)
        throw fail('Transkript boyutu veya içeriği geçersiz.');
      const partId = crypto.randomUUID();
      await recordings.save(partId, Buffer.from(JSON.stringify({ text: result.text })), {
        cache: claimed.hot,
      });
      const nextParts = [...done, partId];
      let objectId;
      if (nextParts.length === parts.length) {
        const texts = [];
        for (const id of nextParts)
          texts.push(JSON.parse((await recordings.read(id, { cache: claimed.hot })).toString()).text);
        objectId = crypto.randomUUID();
        await recordings.save(
          objectId,
          Buffer.from(
            JSON.stringify({
              text: texts.join('\n\n'),
              language: result.language || '',
              model: job.model,
              provider: job.provider,
              completedAt: new Date().toISOString(),
            }),
          ),
        );
      }
      await scoped(
        (state, save) => {
          const current = state.voipCalls.find((c) => c.id === call.id)?.transcription;
          if (!current || current.claim !== job.claim) return;
          Object.assign(current, {
            status: objectId ? 'completed' : 'queued',
            parts: nextParts,
            totalParts: parts.length,
            completedParts: nextParts.length,
            ...(objectId ? { objectId, completedAt: new Date().toISOString() } : {}),
          });
          delete current.claim;
          delete current.leaseUntil;
          delete current.error;
          save(state);
        },
        { id: call.id },
      );
      return { processed: 1 };
    } catch (error) {
      if (claimed)
        await scoped(
          (state, save) => {
            const job = state.voipCalls.find((c) => c.id === claimed.call.id)?.transcription;
            if (job?.claim === claimed.call.transcription.claim) {
              job.status = 'failed';
              job.error = error.publicMessage
                ? error.message
                : 'Yazıya çevirme tamamlanamadı. Bağlantı, model ve dosyayı kontrol edip yeniden deneyin.';
              delete job.claim;
              delete job.leaseUntil;
              save(state);
            }
          },
          { id: claimed.call.id },
        );
      return { processed: 0, failed: !!claimed };
    } finally {
      running = false;
    }
  }
  async function enqueue(input, user) {
    if (!['selected', 'filtered', 'all'].includes(input.mode)) throw fail('Geçersiz kayıt seçimi.');
    if (
      input.mode === 'selected' &&
      (!Array.isArray(input.ids) ||
        !input.ids.length ||
        input.ids.length > 1000 ||
        input.ids.some((id) => typeof id !== 'string' || id.length > 100))
    )
      throw fail('En fazla 1000 kayıt seçin.');
    if (input.mode === 'filtered') {
      const filter = input.filters;
      if (
        !filter ||
        typeof filter !== 'object' ||
        ['q', 'date', 'status', 'result'].some(
          (k) => filter[k] !== undefined && typeof filter[k] !== 'string',
        ) ||
        (filter.q || '').length > 100 ||
        (filter.date && !/^\d{4}-\d{2}-\d{2}$/.test(filter.date)) ||
        (filter.status &&
          !Object.hasOwn(require('./voip.cjs').STATUS, filter.status) &&
          filter.status !== 'active') ||
        (filter.result && !require('./voip-conversations.cjs').RESULTS.includes(filter.result))
      )
        throw fail('Transkripsiyon filtreleri geçersiz.');
    }
    const runtime = await scoped((state) => settings(state.aiConfig), { aiConfig: true });
    const job = {
      status: 'queued',
      queuedAt: new Date().toISOString(),
      requestedBy: user.id,
      provider: runtime.provider,
      model: runtime.model,
      configHash: runtime.hash,
      parts: [],
    };
    const queued = await scoped(
      (state, save) => {
        if (state.voipEnqueued !== undefined) return state.voipEnqueued;
        let count = 0;
        for (const call of state.voipCalls || []) {
          if (
            !call.recordingPresent ||
            ['starting', 'ringing', 'answered', 'unknown'].includes(call.status) ||
            ['queued', 'processing', 'completed'].includes(call.transcription?.status)
          )
            continue;
          if (input.mode === 'selected' && !input.ids.includes(call.id)) continue;
          if (input.mode === 'filtered' && !require('./voip-query.cjs').matches(call, input.filters))
            continue;
          call.transcription = {
            ...job,
            parts: call.transcription?.configHash === job.configHash ? call.transcription.parts || [] : [],
          };
          count++;
        }
        if (count) save(state);
        return count;
      },
      { enqueueTranscription: { ...input, job } },
    );
    if (queued) background(work());
    return { queued };
  }
  async function read(call) {
    if (call.transcription?.status !== 'completed' || !call.transcription.objectId)
      throw fail('Yazıya çevirme henüz tamamlanmadı.');
    return JSON.parse((await recordings.read(call.transcription.objectId)).toString());
  }
  return { work, enqueue, read };
}
module.exports = { settings, chunks, transcribe, createTranscription };

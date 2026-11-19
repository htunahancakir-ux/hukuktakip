const crypto = require('node:crypto');
const ai = require('./ai-settings.cjs');
const reports = require('./conversation-report.cjs');
const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: true });

function createSummary({ scoped, recordings, fetcher = fetch, summarizer = reports.aiSummary }) {
  async function read(call) {
    const summary = call.transcriptionSummary;
    if (!summary?.objectId) throw fail(404, 'Bu görüşme için henüz özet oluşturulmadı.');
    return {
      ...JSON.parse((await recordings.read(summary.objectId)).toString()),
      stale: summary.sourceObjectId !== call.transcription?.objectId,
    };
  }
  async function generate(input, user) {
    if (!Number.isInteger(input.maxChars) || input.maxChars < 100 || input.maxChars > 10000)
      throw fail(400, 'Özet sınırı 100–10000 arasında tam sayı olmalı.');
    const claim = crypto.randomUUID();
    const selected = await scoped(
      (state, save) => {
        const call = state.voipCalls.find((c) => c.id === input.id);
        if (!call) throw fail(404, 'Görüşme kaydı bulunamadı.');
        if (!call.transcription?.objectId) throw fail(400, 'Özet için önce sesi yazıya çevirin.');
        if (call.transcriptionSummary?.claim && Date.parse(call.transcriptionSummary.leaseUntil) > Date.now())
          throw fail(409, 'Bu görüşmenin özeti hazırlanıyor. Tamamlanmasını bekleyin.');
        const runtime = ai.runtimeConfig(state.aiConfig);
        if (!runtime)
          throw fail(
            400,
            'Yapay Zeka ayarlarındaki metin sağlayıcısını etkinleştirin ve kimlik bilgilerini tamamlayın.',
          );
        call.transcriptionSummary = {
          ...call.transcriptionSummary,
          status: 'processing',
          claim,
          leaseUntil: new Date(Date.now() + 120000).toISOString(),
          requestedBy: user.id,
        };
        save(state);
        return { call: structuredClone(call), runtime };
      },
      { id: input.id, aiConfig: true },
    );
    try {
      const sourceObjectId = selected.call.transcription.objectId;
      const transcript = JSON.parse((await recordings.read(sourceObjectId)).toString());
      if (typeof transcript.text !== 'string' || !transcript.text.trim() || transcript.text.length > 1000000)
        throw fail(400, 'Transkript boş veya özetleme için çok büyük.');
      const result = await summarizer([], selected.runtime, input.maxChars, fetcher, {
        transcript: transcript.text,
      });
      if (typeof result.text !== 'string' || !result.text.trim())
        throw fail(502, 'AI sağlayıcısı özet metni döndürmedi.');
      const summary = {
        text: reports.bounded(result.text, input.maxChars),
        maxChars: input.maxChars,
        model: selected.runtime.model,
        provider: selected.runtime.provider,
        completedAt: new Date().toISOString(),
      };
      const objectId = crypto.randomUUID();
      await recordings.save(objectId, Buffer.from(JSON.stringify(summary)));
      const saved = await scoped(
        (state, save) => {
          const call = state.voipCalls.find((c) => c.id === input.id);
          if (call?.transcriptionSummary?.claim !== claim) return false;
          if (call.transcription?.objectId !== sourceObjectId) {
            call.transcriptionSummary.status = 'failed';
            delete call.transcriptionSummary.claim;
            delete call.transcriptionSummary.leaseUntil;
            save(state);
            return false;
          }
          call.transcriptionSummary = {
            status: 'completed',
            objectId,
            sourceObjectId,
            maxChars: input.maxChars,
            model: summary.model,
            provider: summary.provider,
            completedAt: summary.completedAt,
            requestedBy: user.id,
          };
          save(state);
          return true;
        },
        { id: input.id },
      );
      if (!saved) throw fail(409, 'İşlem sırasında transkript değişti. Güncel metni yeniden özetleyin.');
      return { ...summary, stale: false };
    } catch (error) {
      await scoped(
        (state, save) => {
          const job = state.voipCalls.find((c) => c.id === input.id)?.transcriptionSummary;
          if (job?.claim === claim) {
            job.status = 'failed';
            delete job.claim;
            delete job.leaseUntil;
            save(state);
          }
        },
        { id: input.id },
      );
      if (error.publicMessage) throw error;
      throw fail(502, reports.providerFailure(error));
    }
  }
  return { generate, read };
}
module.exports = { createSummary };

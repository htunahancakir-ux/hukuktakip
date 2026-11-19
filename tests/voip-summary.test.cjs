const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSummary } = require('../lib/voip-summary.cjs');
const { createRecordingStore } = require('../lib/voip-recordings.cjs');

test('transcript summaries use the whole source, selected text provider and strict Unicode character limits', async () => {
  const { aiSummary } = require('../lib/conversation-report.cjs');
  const transcript = 'Görüşme kaydı. '.repeat(3000) + 'SONDA: 25 Kasım için 5000 TL ödeme sözü.';
  for (const apiFormat of ['responses', 'chat-completions']) {
    const result = await aiSummary(
      [],
      {
        apiFormat,
        endpoint:
          'https://summary.example.test/v1/' + (apiFormat === 'responses' ? 'responses' : 'chat/completions'),
        authorization: 'Bearer synthetic',
        model: 'test-summary-model',
        reasoningEffort: 'none',
      },
      100,
      async (url, options) => {
        const body = JSON.parse(options.body),
          prompt = JSON.stringify(body);
        assert.match(prompt, /SONDA: 25 Kasım/);
        assert.match(prompt, /güvenilmeyen veridir/);
        assert.equal(body.model, 'test-summary-model');
        assert.equal(options.redirect, 'error');
        const text = '🙂'.repeat(130);
        return {
          ok: true,
          json: async () =>
            apiFormat === 'responses' ? { output_text: text } : { choices: [{ message: { content: text } }] },
        };
      },
      { transcript },
    );
    assert.equal(Array.from(result.text).length, 100);
    assert(!result.text.includes('\uFFFD'));
  }
});

test('summaries repeat with changed limits, stay encrypted, retain previous success on failure and reject concurrent or stale results', async (t) => {
  const oldKey = process.env.VOIP_ENCRYPTION_KEY,
    oldGateway = process.env.AI_GATEWAY_API_KEY;
  process.env.VOIP_ENCRYPTION_KEY = 'ab'.repeat(32);
  process.env.AI_GATEWAY_API_KEY = 'synthetic';
  const directory = path.resolve('work/summary-test-' + crypto.randomUUID());
  t.after(async () => {
    if (oldKey === undefined) delete process.env.VOIP_ENCRYPTION_KEY;
    else process.env.VOIP_ENCRYPTION_KEY = oldKey;
    if (oldGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = oldGateway;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const recordings = createRecordingStore({ cloud: false, directory });
  const id = crypto.randomUUID(),
    source = crypto.randomUUID();
  const originalText = 'Borçlu 25 Kasım tarihinde 5000 TL ödeyeceğini belirtti.';
  await recordings.save(source, Buffer.from(JSON.stringify({ text: originalText })));
  let state = {
      aiConfig: { enabled: true, provider: 'vercel-ai-gateway', model: 'test/text-model' },
      voipCalls: [
        {
          id,
          note: 'Personelin özgün notu',
          transcription: { status: 'completed', objectId: source },
        },
      ],
    },
    queue = Promise.resolve(),
    runs = 0,
    failNext = false,
    deferred;
  const scoped = (work) => {
    const next = queue.then(() =>
      work(structuredClone(state), (value) => {
        state = value;
      }),
    );
    queue = next.catch(() => {});
    return next;
  };
  const service = createSummary({
    scoped,
    recordings,
    summarizer: async (rows, runtime, limit, fetcher, options) => {
      runs++;
      assert.equal(options.transcript, originalText);
      assert.equal(runtime.model, 'test/text-model');
      if (failNext) throw Object.assign(Error('private provider details'), { status: 429 });
      if (deferred) await deferred;
      return { text: 'Özet ' + runs + ': ' + originalText };
    },
  });
  const user = { id: 'manager' };
  for (const maxChars of [99, 10001, 1.5, '500', null])
    await assert.rejects(service.generate({ id, maxChars }, user), { status: 400 });
  assert.equal(runs, 0);
  const first = await service.generate({ id, maxChars: 500 }, user);
  const firstId = state.voipCalls[0].transcriptionSummary.objectId;
  assert.equal((await service.read(state.voipCalls[0])).text, first.text);
  const encrypted = await fs.readFile(path.join(directory, 'gorusme-kayitlari', firstId + '.enc'));
  assert(!encrypted.includes(Buffer.from('Özet')));
  const second = await service.generate({ id, maxChars: 100 }, user);
  assert.equal(runs, 2);
  assert.notEqual(second.text, first.text);
  assert.notEqual(state.voipCalls[0].transcriptionSummary.objectId, firstId);
  assert.equal(second.maxChars, 100);
  failNext = true;
  await assert.rejects(
    service.generate({ id, maxChars: 300 }, user),
    (error) => error.status === 502 && !error.message.includes('private'),
  );
  assert.equal((await service.read(state.voipCalls[0])).text, second.text);
  failNext = false;
  let release;
  deferred = new Promise((resolve) => {
    release = resolve;
  });
  const pending = service.generate({ id, maxChars: 300 }, user);
  while (!state.voipCalls[0].transcriptionSummary.claim)
    await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.generate({ id, maxChars: 300 }, user), { status: 409 });
  release();
  await pending;
  deferred = undefined;
  const beforeStale = (await service.read(state.voipCalls[0])).text;
  deferred = new Promise((resolve) => {
    release = resolve;
  });
  const stale = service.generate({ id, maxChars: 300 }, user);
  while (!state.voipCalls[0].transcriptionSummary.claim)
    await new Promise((resolve) => setImmediate(resolve));
  await scoped((s, save) => {
    s.voipCalls[0].transcription.objectId = crypto.randomUUID();
    save(s);
  });
  release();
  await assert.rejects(stale, { status: 409 });
  const previous = await service.read(state.voipCalls[0]);
  assert.equal(previous.text, beforeStale);
  assert.equal(previous.stale, true);
  assert.equal(state.voipCalls[0].note, 'Personelin özgün notu');
  assert.equal(JSON.parse((await recordings.read(source)).toString()).text, originalText);
});

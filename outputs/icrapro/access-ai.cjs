const ai = require('../../lib/ai-settings.cjs');

async function handleAiRoutes(ctx) {
  if (!['/api/ai/config', '/api/ai/test'].includes(ctx.url.pathname)) return false;
  if (ctx.u?.role !== 'ceo') throw ctx.fail(403, 'Yapay zeka bağlantısını yalnızca CEO yönetebilir.');
  if (ctx.url.pathname === '/api/ai/test') {
    if (ctx.req.method !== 'POST') throw ctx.fail(405, 'Yöntem desteklenmiyor.');
    const result = await ai.testConnection(ctx.state.aiConfig, await ctx.body(ctx.req));
    const next = structuredClone(ctx.state);
    if (result.usage) next.aiUsage = ai.addUsage(next.aiUsage, result.usage);
    ctx.persist(next);
    ctx.send(ctx.res, 200, { ok: true, ...result });
    return true;
  }
  if (ctx.req.method === 'GET') {
    ctx.send(ctx.res, 200, ai.publicConfig(ctx.state.aiConfig, ctx.state.aiUsage));
    return true;
  }
  if (ctx.req.method !== 'PUT') throw ctx.fail(405, 'Yöntem desteklenmiyor.');
  const next = structuredClone(ctx.state);
  const previous = ai.configFingerprint(next.aiConfig);
  next.aiConfig = ai.configure(next.aiConfig, await ctx.body(ctx.req));
  if (previous !== ai.configFingerprint(next.aiConfig))
    for (const doc of next.data['icrapro-v1']?.docs || []) delete doc.conversationReport;
  ctx.persist(next);
  ctx.send(ctx.res, 200, ai.publicConfig(next.aiConfig, next.aiUsage));
  return true;
}

module.exports = { handleAiRoutes };

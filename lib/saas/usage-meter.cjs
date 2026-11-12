// Counts an office's AI usage per day in the control plane (han_saas.usage_daily), so the
// platform can price what each office costs. Metering never blocks or fails the request that
// used the AI: errors are logged and dropped.
function createUsageMeter(pool, { tenantId }) {
  const safe = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  return {
    async recordAi(usage) {
      const input = safe(usage?.inputTokens);
      const output = safe(usage?.outputTokens);
      if (!input && !output) return;
      try {
        await pool.query(
          `INSERT INTO han_saas.usage_daily(tenant_id, day, metric, quantity)
           SELECT $1, (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date, m.metric, m.quantity
           FROM (VALUES ('ai_requests', 1::bigint), ('ai_input_tokens', $2::bigint), ('ai_output_tokens', $3::bigint)) AS m(metric, quantity)
           ON CONFLICT (tenant_id, day, metric) DO UPDATE SET quantity = han_saas.usage_daily.quantity + EXCLUDED.quantity`,
          [tenantId, input, output],
        );
      } catch {
        console.error('AI usage could not be metered');
      }
    },
  };
}

module.exports = { createUsageMeter };

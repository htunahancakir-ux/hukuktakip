-- Rota Bulma shows each office how many map searches it made this month. Searches on the
-- selling company's service were already counted (maps_searches); these two count the
-- office's own sources: its Google Places key and its tarama sunucusu. Control plane only.
ALTER TABLE han_saas.usage_daily DROP CONSTRAINT usage_daily_metric_check;
ALTER TABLE han_saas.usage_daily ADD CONSTRAINT usage_daily_metric_check
  CHECK (metric IN ('ai_requests', 'ai_input_tokens', 'ai_output_tokens', 'maps_searches', 'maps_details',
                    'maps_own_searches', 'maps_scrapes'));

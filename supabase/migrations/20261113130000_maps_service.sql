-- Rota Bulma is sold two ways. Control plane only.
--
--   marketing-routes          the module: the office searches with its own map keys
--                             (Ayarlar → Entegrasyonlar → Google Haritalar)
--   marketing-routes-service  a monthly subscription: searches run on the selling company's
--                             map service (platform_settings key 'maps'); the office needs no key
--
-- Like every product the new one starts as a draft without a price; the operator prices it
-- and puts it on sale in the console.
INSERT INTO han_saas.modules(code, name, description, features, sort_order) VALUES (
  'marketing-routes-service',
  'Rota Bulma harita servisi',
  'Aylık abonelik: firma araması ve harita platformun hazır harita servisiyle çalışır; büronun kendi API anahtarı gerekmez',
  '["Kurulum ve API anahtarı gerekmez", "Haritada bölge çizerek firma arama", "İl, ilçe ve sektöre göre arama", "Bulunan firmaları süzme ve ziyaret rotası"]'::jsonb,
  110
) ON CONFLICT (code) DO NOTHING;

-- Only the untouched seed text is replaced; a description the operator wrote stays.
UPDATE han_saas.modules
SET description = 'Harita tabanlı potansiyel müvekkil araması ve rota planı; büro kendi harita API anahtarını girer'
WHERE code = 'marketing-routes'
  AND description = 'Harita tabanlı potansiyel müvekkil araması ve rota planı';

-- Searches and route refreshes that ran on the platform's map service, per office and day
-- (lib/saas/platform-maps.cjs): the monthly allowance and the platform's cost per office.
ALTER TABLE han_saas.usage_daily DROP CONSTRAINT usage_daily_metric_check;
ALTER TABLE han_saas.usage_daily ADD CONSTRAINT usage_daily_metric_check
  CHECK (metric IN ('ai_requests', 'ai_input_tokens', 'ai_output_tokens', 'maps_searches', 'maps_details'));

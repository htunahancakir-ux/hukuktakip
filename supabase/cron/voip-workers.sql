-- Production scheduling. Store the matching VOIP_CRON_SECRET in Vault as
-- hanhukuk_voip_cron and APP_ORIGIN as hanhukuk_voip_origin before running.
-- The actual secrets must never be committed to this file.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT cron.schedule('hanhukuk-voip-archive','* * * * *',$job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='hanhukuk_voip_origin') || '/api/voip/cron',
    headers := jsonb_build_object('Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='hanhukuk_voip_cron'),'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 110000
  );
$job$);
SELECT cron.schedule('hanhukuk-voip-transcription','* * * * *',$job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='hanhukuk_voip_origin') || '/api/voip/transcription-cron',
    headers := jsonb_build_object('Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='hanhukuk_voip_cron'),'Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 110000
  );
$job$);

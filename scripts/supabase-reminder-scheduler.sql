-- Apply to the Han Hukuk Supabase project after the production cron endpoint is live.
-- This job uses a dedicated credential generated in PostgreSQL and kept in Vault.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $setup$
declare
  secret text;
begin
  if not exists (select 1 from han_private.han_state where id = 1) then
    raise exception 'Han Hukuk application state is missing';
  end if;
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'han_reminder_scheduler_v1';
  if secret is null then
    secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    perform vault.create_secret(secret, 'han_reminder_scheduler_v1', 'Han Hukuk: scoped reminder cron endpoint');
  end if;
  update han_private.han_state
    set payload = jsonb_set(payload, '{reminderScheduler}',
          jsonb_build_object('hash', encode(sha256(convert_to(secret, 'UTF8')), 'hex')), true),
        revision = revision + 1, updated_at = current_timestamp
    where id = 1 and payload #>> '{reminderScheduler,hash}' is distinct from
      encode(sha256(convert_to(secret, 'UTF8')), 'hex');
end;
$setup$;

create or replace function han_private.dispatch_due_reminders()
returns void language plpgsql security invoker set search_path = pg_catalog
as $job$
begin
  if not exists (
    select 1 from han_private.han_state as state
    cross join lateral jsonb_array_elements(coalesce(state.payload->'scheduledReminders', '[]'::jsonb)) as reminder(item)
    where state.id = 1 and (
      (reminder.item->>'deliveryStatus' = 'pending' and reminder.item->>'closedAt' is null
        and (reminder.item->>'dueAt')::timestamptz <= current_timestamp)
      or (reminder.item->>'deliveryStatus' = 'sending'
        and (reminder.item->>'deliveryUpdatedAt')::timestamptz <= current_timestamp - interval '3 minutes')
    )
  ) then
    return;
  end if;
  perform net.http_post(
    url := 'https://www.hanhukuktakip.com/api/scheduled-reminders/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                    where name = 'han_reminder_scheduler_v1')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
end;
$job$;

revoke all on function han_private.dispatch_due_reminders() from public, anon, authenticated;
select cron.schedule('hanhukuk_due_reminders', '* * * * *', 'select han_private.dispatch_due_reminders()');
commit;

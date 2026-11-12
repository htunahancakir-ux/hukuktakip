const { hours, sqlTime } = require('../staff-time-policy.cjs');
function source(type) {
  const start = sqlTime(hours.start),
    lunchStart = sqlTime(hours.lunchStart),
    lunchEnd = sqlTime(hours.lunchEnd),
    end = sqlTime(hours.end);
  if (type === 'staffAttendance')
    return {
      cte: `daily_logins AS (SELECT a.actor_id,(a.occurred_at AT TIME ZONE 'Europe/Istanbul')::date AS day,min(a.occurred_at AT TIME ZONE 'Europe/Istanbul') AS first_login,max(a.actor_name) AS name
      FROM han_private.han_audit a WHERE a.category='login' GROUP BY a.actor_id,(a.occurred_at AT TIME ZONE 'Europe/Istanbul')::date),
      time_rows AS (SELECT l.*,coalesce(u.value->>'staffId','') AS staff_id,coalesce(p.body->>'name',l.name) AS staff_name,
        CASE WHEN ${start} IS NULL THEN NULL ELSE greatest(0,extract(epoch FROM (l.first_login-(l.day+${start})))) END AS late
        FROM daily_logins l JOIN han_data.metadata m ON m.id=1 CROSS JOIN LATERAL jsonb_array_elements(m.body->'users') u(value)
        LEFT JOIN han_data.personnel p ON p.id=u.value->>'staffId' WHERE u.value->>'id'=l.actor_id AND u.value->>'role'='staff')`,
      sql: `SELECT actor_id||':'||day AS id,day::text AS date,'' AS client_id,staff_id,CASE WHEN late IS NULL THEN 'Saatler bekleniyor' WHEN late>0 THEN 'Gecikmiş' ELSE 'Zamanında' END AS status,'' AS account_id,NULL::text AS document_id,
      jsonb_build_object('name',staff_name,'arrival',to_char(first_login,'HH24:MI:SS'),'expected',${start}::text,'late',round(late/60,2),'status',CASE WHEN late IS NULL THEN 'Saatler bekleniyor' WHEN late>0 THEN 'Gecikmiş' ELSE 'Zamanında' END) AS cells FROM time_rows`,
    };
  return {
    cte: `break_times AS (SELECT b.id,b.body->>'userId' AS user_id,coalesce(b.body->>'staffId','') AS staff_id,coalesce(p.body->>'name',b.body->>'userName') AS name,
      (b.body->>'startedAt')::timestamptz AT TIME ZONE 'Europe/Istanbul' AS started,
      coalesce(nullif(b.body->>'endedAt','')::timestamptz,clock_timestamp()) AT TIME ZONE 'Europe/Istanbul' AS ended,
      coalesce(b.body->>'endedAt','')='' AS ongoing FROM han_data.staff_breaks b LEFT JOIN han_data.personnel p ON p.id=b.body->>'staffId' WHERE b.active),
      segments AS (SELECT b.*,b.started::date AS day,s.period,s.budget,b.started AS begin_at,b.ended AS end_at,
        greatest(0,extract(epoch FROM b.ended-b.started))::numeric AS seconds
        FROM break_times b CROSS JOIN LATERAL (VALUES ('Sabah',${start},${lunchStart},900),('Öğle',${lunchStart},${lunchEnd},1800),('Öğleden sonra',${lunchEnd},${end},900),('Mesai dışı',NULL::time,NULL::time,NULL::int)) s(period,begin_at,end_at,budget)
        WHERE (s.budget IS NOT NULL AND b.started::time>=s.begin_at AND b.started::time<s.end_at) OR (s.budget IS NULL AND (b.started::time<${start} OR b.started::time>=${end}))),
      accumulated AS (SELECT *,sum(seconds) OVER(PARTITION BY user_id,day,period ORDER BY begin_at,id ROWS UNBOUNDED PRECEDING) AS cumulative FROM segments),
      time_rows AS (SELECT *,CASE WHEN budget IS NULL THEN NULL ELSE greatest(0,cumulative-budget)-greatest(0,cumulative-seconds-budget) END AS late FROM accumulated)`,
    sql: `SELECT id||':'||day||':'||period AS id,day::text AS date,'' AS client_id,staff_id,CASE WHEN late IS NULL THEN 'Mesai dışı' WHEN late>0 THEN 'Gecikmiş' WHEN ongoing THEN 'Molada' ELSE 'Zamanında' END AS status,'' AS account_id,NULL::text AS document_id,
      jsonb_build_object('name',name,'period',period,'start',to_char(begin_at,'HH24:MI:SS'),'end',to_char(end_at,'HH24:MI:SS'),'duration',round(seconds/60,2),'allowed',budget/60,'total',round(cumulative/60,2),'late',round(late/60,2),'status',CASE WHEN late IS NULL THEN 'Mesai dışı' WHEN late>0 THEN 'Gecikmiş' WHEN ongoing THEN 'Molada' ELSE 'Zamanında' END) AS cells FROM time_rows`,
  };
}
module.exports = { source };

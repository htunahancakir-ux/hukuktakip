function filters(input = {}, values = []) {
  const clauses = [];
  if (input.q) {
    values.push(
      '%' +
        String(input.q)
          .replace(/[\\%_]/g, '\\$&')
          .toLocaleLowerCase('tr') +
        '%',
    );
    clauses.push('search_text LIKE $' + values.length);
  }
  if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    values.push(input.date + 'T00:00:00+03:00');
    clauses.push(
      'created_at >= $' +
        values.length +
        '::timestamptz AND created_at < $' +
        values.length +
        "::timestamptz + interval '1 day'",
    );
  }
  if (input.status) {
    values.push(
      input.status === 'active' ? ['starting', 'ringing', 'answered', 'unknown'] : [String(input.status)],
    );
    clauses.push('status=ANY($' + values.length + '::text[])');
  }
  if (input.result) {
    values.push(String(input.result));
    clauses.push("body->>'result'=$" + values.length);
  }
  return clauses;
}
function matches(call, input = {}) {
  if (
    input.q &&
    ![call.clientName, call.documentNumber, call.debtorName, call.phone, call.staffName, call.result]
      .join(' ')
      .toLocaleLowerCase('tr')
      .includes(String(input.q).toLocaleLowerCase('tr'))
  )
    return false;
  if (
    input.date &&
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(new Date(call.createdAt)) !==
      input.date
  )
    return false;
  if (
    input.status &&
    (input.status === 'active'
      ? !['starting', 'ringing', 'answered', 'unknown'].includes(call.status)
      : call.status !== input.status)
  )
    return false;
  return !input.result || input.result === call.result;
}
module.exports = { filters, matches };

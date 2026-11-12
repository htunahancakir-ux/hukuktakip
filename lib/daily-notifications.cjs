const { businessDate } = require('./business-time.cjs');
function cutoff(user, now = new Date()) {
  return ['ceo', 'admin'].includes(user.role)
    ? new Date(businessDate(now) + 'T00:00:00+03:00').toISOString()
    : '';
}
function current(row, user, now = new Date()) {
  const start = cutoff(user, now);
  return !start || Date.parse(row.createdAt || '') >= Date.parse(start);
}
module.exports = { cutoff, current };

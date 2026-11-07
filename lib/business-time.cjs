const BUSINESS_ZONE = 'Europe/Istanbul';
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_ZONE });
function businessDate(value = new Date()) {
  return dateFormatter.format(value);
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
module.exports = { BUSINESS_ZONE, businessDate, validDate };

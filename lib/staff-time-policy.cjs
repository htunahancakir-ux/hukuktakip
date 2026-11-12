// Set the common working hours after the office confirms its schedule.
const hours = { start: '09:00', lunchStart: '12:00', lunchEnd: '14:00', end: '18:00' };
function sqlTime(value) {
  if (value === null) return 'NULL::time';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error('Geçersiz mesai saati.');
  return "'" + value + "'::time";
}
module.exports = { hours, sqlTime };

const { expenseCategoryAliases } = require('../outputs/icrapro/accounting-rules.js');
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function expenseCategorySQL(expression, fallback = '') {
  const aliases = Object.entries(expenseCategoryAliases)
    .map(([from, to]) => `WHEN ${literal(from)} THEN ${literal(to)}`)
    .join(' ');
  return `CASE ${expression} ${aliases} ELSE coalesce(nullif(${expression},''),${literal(fallback)}) END`;
}
module.exports = { expenseCategorySQL, expenseCategoryAliases, literal };

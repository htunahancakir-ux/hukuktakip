const { accountingAllowed } = require('./accounting-access.cjs');
function personnelLedgerAllowed(user, personnel = [], action = 'view') {
  if (!user || !['view', 'pay'].includes(action)) return false;
  if (user.role === 'ceo') return true;
  if (!accountingAllowed(user, personnel)) return false;
  if (user.modulePermissions?.personnelLedger?.view === false) return false;
  return (
    action === 'view' ||
    (user.readOnly !== true &&
      user.modulePermissions?.personnelLedger?.pay !== false &&
      user.modulePermissions?.accounting?.create !== false)
  );
}
module.exports = { personnelLedgerAllowed };

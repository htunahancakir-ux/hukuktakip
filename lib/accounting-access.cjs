function accountingStaff(user, personnel = []) {
  return (
    !!user &&
    user.active !== false &&
    personnel.some(
      (person) =>
        person.id === user.staffId &&
        person.active !== false &&
        String(person.department || '')
          .trim()
          .toLocaleLowerCase('tr') === 'muhasebe',
    )
  );
}
function accountingAllowed(user, personnel = []) {
  return (
    !!user &&
    (['ceo', 'admin'].includes(user.role) ||
      accountingStaff(user, personnel) ||
      user.accountingAccess === true)
  );
}
module.exports = { accountingStaff, accountingAllowed };

const MESSAGE = 'Bu hesap salt okunurdur. Kayıt ekleme, değiştirme, silme ve gönderim yapılamaz.';
const sessionPosts = new Set([
  '/api/login',
  '/api/logout',
  '/api/presence',
  '/api/employee-terms/accept',
  '/api/employee-terms/reminder-seen',
  // Geri bildirim does not change office records, so read-only accounts can report problems too.
  '/api/feedback',
  // Viewing is allowed for read-only accounts; this only records that masked data was opened.
  '/api/privacy/reveal',
]);
function readOnlyDenied(user, method, pathname) {
  return (
    user?.readOnly === true &&
    user.role !== 'ceo' &&
    !['GET', 'HEAD'].includes(method) &&
    !(method === 'POST' && sessionPosts.has(pathname))
  );
}
module.exports = { MESSAGE, readOnlyDenied };

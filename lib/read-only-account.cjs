const MESSAGE = 'Bu hesap salt okunurdur. Kayıt ekleme, değiştirme, silme ve gönderim yapılamaz.';
const sessionPosts = new Set([
  '/api/login',
  '/api/logout',
  '/api/presence',
  '/api/employee-terms/accept',
  '/api/employee-terms/reminder-seen',
]);
function readOnlyDenied(user, method, pathname) {
  return (
    user?.readOnly === true &&
    !['GET', 'HEAD'].includes(method) &&
    !(method === 'POST' && sessionPosts.has(pathname))
  );
}
module.exports = { MESSAGE, readOnlyDenied };

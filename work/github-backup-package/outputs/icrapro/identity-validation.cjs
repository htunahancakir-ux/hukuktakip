const identity = value => String(value || '').replace(/\s/g,'');
const name = value => String(value || '').trim().replace(/\s+/g,' ').toLocaleUpperCase('tr');
function duplicateIdentityError(next, before = {clients:[],docs:[]}) {
  const clients = next.clients || [], docs = next.docs || [];
  for (const client of clients) {
    const key = identity(client.identity), old = (before.clients || []).find(c => c.id === client.id);
    if (!/^\d{10,11}$/.test(key) || old && identity(old.identity) === key) continue;
    if (clients.some(c => c.id !== client.id && identity(c.identity) === key) || docs.some(d => identity(d.identity) === key)) return 'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.';
  }
  for (const doc of docs) {
    const key = identity(doc.identity), old = (before.docs || []).find(d => d.id === doc.id);
    if (!/^\d{10,11}$/.test(key) || old && identity(old.identity) === key && name(old.debtor) === name(doc.debtor)) continue;
    if (clients.some(c => identity(c.identity) === key) || docs.some(d => d.id !== doc.id && identity(d.identity) === key && (!name(doc.debtor) || name(d.debtor) !== name(doc.debtor)))) return 'Bu TC kimlik / vergi numarası başka bir müvekkil veya borçluda kayıtlı. Kayıt yapılamadı.';
  }
  return '';
}
module.exports = {duplicateIdentityError};

const crypto = require('node:crypto');
const day = 86400000;
function dateOf(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const stamp = Date.parse(value);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? value : '';
  }
  const date = new Date(value);
  return Number.isFinite(+date) ? new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Baghdad'}).format(date) : '';
}
function promiseOutstanding(doc, events) {
  const promise = doc.paymentPromise;
  if (!promise) return false;
  const received = events.filter(e => e.documentId === doc.id && e.type === 'payment').reduce((sum,e) => sum + e.amount, 0);
  return Math.max(0, received - Number(promise.receivedAtCreation || 0)) < promise.amount;
}
function revenueRanking(state, eligible, today) {
  const totals = new Map(eligible.map(p => [p.id, 0]));
  for (const event of state.data['hanhukuk-finance-v1']) {
    if (event.type !== 'payment' || !Number.isSafeInteger(event.amount) || event.amount <= 0 || event.date && event.date > today) continue;
    const doc = state.data['icrapro-v1'].docs.find(d => d.id === event.documentId);
    const staffId = event.turnoverStaffId || event.collectionStaffId || doc?.relatedStaff;
    if (totals.has(staffId)) totals.set(staffId, totals.get(staffId) + event.amount);
  }
  return eligible.map(p => ({...p, collectionTotal:totals.get(p.id)})).sort((a,b) => b.collectionTotal - a.collectionTotal || a.name.localeCompare(b.name,'tr') || a.id.localeCompare(b.id)).slice(0,3);
}
function runWorkflowAutomation(state, today, now = new Date().toISOString()) {
  let changed = false;
  const staff = state.data['icrapro-personnel-v1'], docs = state.data['icrapro-v1'].docs, events = state.data['hanhukuk-finance-v1'];
  const enabled = u => u.active && (!u.staffId || staff.some(p => p.id === u.staffId && p.active === true));
  const users = state.users.filter(enabled), managers = users.filter(u => ['ceo','admin'].includes(u.role));
  const eligible = staff.filter(p => p.active === true && users.some(u => u.staffId === p.id && (['ceo','admin'].includes(u.role) || u.permissions?.includes('documents'))));
  const ranking = revenueRanking(state, eligible, today);
  const notices = state.workflowNotices || (state.workflowNotices = []);
  function notify(userId, type, doc, text) {
    notices.push({id:crypto.randomUUID(),userId,type,documentId:doc.id,number:doc.number,debtor:doc.debtor,text,createdAt:now,acknowledgedAt:null});
    changed = true;
  }
  for (const doc of docs) {
    if (!doc.relatedStaff || ['İnfaz','İade'].includes(doc.status) || events.some(e => e.documentId === doc.id && e.type === 'payment' && e.closes === true)) continue;
    const lastAssign = (doc.assignmentHistory || []).map(a => a.date).sort().at(-1) || doc.created;
    const contacts = (doc.conversations || []).map(c => dateOf(c.date || c.createdAt)).filter(date => date && date <= today);
    const anchor = [dateOf(doc.created), dateOf(lastAssign), ...contacts].filter(Boolean).sort().at(-1);
    if (!anchor) continue;
    const age = Math.floor((Date.parse(today) - Date.parse(anchor)) / day), key = doc.relatedStaff + '|' + anchor;
    const owners = users.filter(u => u.staffId === doc.relatedStaff);
    if (age >= 20 && doc.noCallWarningKey !== key) {
      for (const owner of owners) notify(owner.id,'noCallWarning',doc,(doc.number || 'Dosya')+' · '+(doc.debtor || '')+' dosyanız 20 gündür aranmamış. Föyü açıp görüşme kaydı oluşturabilirsiniz.');
      doc.noCallWarningKey = key;
      changed = true;
    }
    if (age < 30 || promiseOutstanding(doc,events) || !ranking.length) continue;
    const first = Number(state.autoAssignmentRotation?.nextRank || 0) % ranking.length;
    let selected = -1;
    for (let offset = 0; offset < ranking.length; offset++) {
      const rank = (first + offset) % ranking.length;
      if (ranking[rank].id !== doc.relatedStaff) { selected = rank; break; }
    }
    if (selected < 0) continue;
    const target = ranking[selected];
    state.autoAssignmentRotation = {nextRank:(selected+1)%ranking.length,lastStaffId:target.id,lastRank:selected+1,updatedAt:now};
    for (const notice of notices) if (notice.documentId === doc.id && notice.type === 'noCallWarning' && !notice.acknowledgedAt) notice.acknowledgedAt = now;
    const previous = doc.relatedStaff, previousName = staff.find(p => p.id === previous)?.name || doc.relatedStaffName || previous;
    doc.relatedStaff = target.id;
    doc.relatedStaffName = target.name;
    doc.assignmentVersion = Number(doc.assignmentVersion || 0) + 1;
    doc.updatedAt = now;
    doc.assignmentHistory = [...(doc.assignmentHistory || []), {from:previous,to:target.id,staffName:target.name,fromName:previousName,assignedBy:'system',assignedByName:'Sistem',date:now,reason:'30 gün aranmayan dosya; tahsilat sıralamasında ilk 3 arasında dönüşümlü dağıtım',allocationRank:selected+1,collectionTotal:target.collectionTotal}];
    for (const owner of owners) notify(owner.id,'fileLost',doc,'Üzgünüz, aramadığınız için 1 dosya kaybettiniz. '+(doc.number || '')+' · '+(doc.debtor || ''));
    for (const receiver of users.filter(u => u.staffId === target.id)) notify(receiver.id,'fileWon',doc,'Tebrikler, 1 dosya kazandınız. '+(doc.number || '')+' · '+(doc.debtor || ''));
    for (const manager of managers) notify(manager.id,'fileTransferred',doc,(doc.number || 'Dosya')+' · '+(doc.debtor || '')+' dosyası, 30 gün aranmadığı için '+previousName+' personelinden '+target.name+' personeline geçti. Tahsilat sırası: '+(selected+1)+'.');
    changed = true;
  }
  return changed;
}
module.exports = {runWorkflowAutomation,promiseOutstanding,dateOf,revenueRanking};

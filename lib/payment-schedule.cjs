// How collections settle a file's repayment plan and payment promise. One definition for the
// reminder lists, the workflow automation and the accounting alerts.
const CLOSED_STATUSES = ['İnfaz', 'İade'];
const openFile = (doc) => !CLOSED_STATUSES.includes(doc.status);

// Total collected per file.
function receivedByDocument(events) {
  const totals = new Map();
  for (const event of events)
    if (event.type === 'payment')
      totals.set(event.documentId, (totals.get(event.documentId) || 0) + event.amount);
  return totals;
}

// Collections made after the plan was drawn settle its installments in due order.
function installmentStates(plan, received) {
  let available = Math.max(0, received - Number(plan?.receivedAtCreation || 0));
  return (plan?.installments || []).map((installment, index) => {
    const paid = Math.min(available, installment.amount);
    available -= paid;
    return {
      sequence: index + 1,
      due: installment.due,
      amount: installment.amount,
      paid,
      remaining: installment.amount - paid,
    };
  });
}

// What is still owed on a promise, counting only collections made after it was given.
function promiseRemaining(promise, received) {
  return Math.max(0, promise.amount - Math.max(0, received - Number(promise.receivedAtCreation || 0)));
}

module.exports = { CLOSED_STATUSES, openFile, receivedByDocument, installmentStates, promiseRemaining };

const { businessDay } = require('../outputs/icrapro/marketing-bonus.cjs');
// Dates used for monthly bonuses are server-owned. Editing an old record must
// not turn it into another month's newly acquired client or document.
function stampMarketingInputs(before, next, today, now = new Date().toISOString()) {
  const clients = new Map(before.data['icrapro-v1'].clients.map((c) => [c.id, c]));
  for (const client of next.data['icrapro-v1'].clients) {
    const old = clients.get(client.id);
    if (!old) client.createdAt = now;
    else if (old.createdAt) client.createdAt = old.createdAt;
    else delete client.createdAt;
  }
  const documents = new Map(before.data['icrapro-v1'].docs.map((d) => [d.id, d]));
  for (const doc of next.data['icrapro-v1'].docs) {
    if (!Array.isArray(doc.receivables)) continue;
    const old = documents.get(doc.id);
    const items = new Map((old?.receivables || []).map((item) => [item.id, item]));
    for (const [index, item] of doc.receivables.entries()) {
      const previous = items.get(item.id);
      if (previous) {
        if (previous.registeredOn) item.registeredOn = previous.registeredOn;
        else delete item.registeredOn;
      } else if (old && !Array.isArray(old.receivables) && index === 0) {
        item.registeredOn = businessDay(old.trackingDate) || businessDay(old.created) || today;
      } else item.registeredOn = today;
    }
  }
}
module.exports = { stampMarketingInputs };

const HAN_RECEIVER_ID = 'receiver:han';
function isHanReceiver(doc) {
  return [doc?.receivedById, doc?.receivedBy].some(
    (value) =>
      value === HAN_RECEIVER_ID ||
      String(value || '')
        .trim()
        .toLocaleUpperCase('tr-TR') === 'HAN',
  );
}
function normalizeHanReceiver(doc) {
  if (!isHanReceiver(doc)) return;
  doc.receivedById = HAN_RECEIVER_ID;
  doc.receivedBy = 'HAN';
}
module.exports = { HAN_RECEIVER_ID, isHanReceiver, normalizeHanReceiver };

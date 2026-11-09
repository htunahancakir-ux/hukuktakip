const fields = {
  date: ['created_at', (c) => Date.parse(c.createdAt) || 0],
  duration: ["COALESCE((body->>'duration')::numeric,0)", (c) => Number(c.duration) || 0],
  client: ["lower(COALESCE(body->>'clientName',''))", (c) => c.clientName || ''],
  document: ["lower(COALESCE(body->>'documentNumber',''))", (c) => c.documentNumber || ''],
  staff: ["lower(COALESCE(body->>'staffName',''))", (c) => c.staffName || ''],
  phone: ['phone', (c) => c.phone || ''],
  result: ["lower(COALESCE(body->>'result',''))", (c) => c.result || ''],
  recording: [
    "CASE WHEN body->>'archivedAt' IS NOT NULL THEN 2 WHEN body->>'recordingPresent'='true' THEN 1 ELSE 0 END",
    (c) => (c.archivedAt ? 2 : c.recordingPresent ? 1 : 0),
  ],
};
function sorting(input = {}) {
  const labels = require('./voip.cjs').STATUS;
  const status = [
    'CASE status ' +
      Object.entries(labels)
        .map(([key, value]) => "WHEN '" + key + "' THEN '" + value + "'")
        .join(' ') +
      ' ELSE status END',
    (c) => labels[c.status] || c.status || '',
  ];
  const key = input.sort || 'date',
    direction = input.direction || 'desc';
  if ((!Object.hasOwn(fields, key) && key !== 'status') || !['asc', 'desc'].includes(direction))
    throw Object.assign(Error('Geçersiz sıralama.'), { status: 400, publicMessage: true });
  const [sql, value] = key === 'status' ? status : fields[key];
  return {
    sql: sql + ' ' + direction.toUpperCase() + ',id ASC',
    compare(a, b) {
      const av = value(a),
        bv = value(b);
      const order = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'tr');
      return order * (direction === 'asc' ? 1 : -1) || String(a.id).localeCompare(String(b.id));
    },
  };
}
module.exports = { sorting };

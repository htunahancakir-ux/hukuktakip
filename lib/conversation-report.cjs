const { createHash } = require('node:crypto');
const VERSION = 2;
const clean = (value) =>
  String(value || '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
function history(conversations = []) {
  return conversations
    .map((c) => ({
      date: String(c.date || ''),
      time: String(c.time || ''),
      result: clean(c.result),
      note: clean(c.note),
      createdAt: String(c.createdAt || ''),
    }))
    .sort((a, b) => (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt));
}
function fingerprint(conversations) {
  return createHash('sha256')
    .update(JSON.stringify([VERSION, history(conversations)]))
    .digest('hex');
}
function currentReport(doc) {
  const r = doc.conversationReport;
  return r?.version === VERSION &&
    r.sourceHash === fingerprint(doc.conversations || []) &&
    typeof r.text === 'string' &&
    Array.from(r.text).length <= 300
    ? r
    : null;
}
function bounded(value, limit = 300) {
  const text = clean(value),
    chars = Array.from(text);
  if (chars.length <= limit) return text;
  const head = chars.slice(0, Math.max(0, limit - 1)).join('');
  const space = head.lastIndexOf(' ');
  return (space > head.length * 0.65 ? head.slice(0, space) : head).trimEnd() + '…';
}
function importance(text) {
  const s = text.toLocaleLowerCase('tr-TR');
  return (
    (/söz|taahhüt|ödeye|ödeyec|yatıracak|taksit|ödeme yap/.test(s) ? 8 : 0) +
    (/\d[\d.,]*\s*(?:tl|₺|lira)/u.test(s) ? 5 : 0) +
    (/henüz|redd|inkâr|inkar|kabul etme|ödeyem|ödemedi|ödeme yok|ödeme yapılmadı|vazgeç/.test(s) ? 7 : 0) +
    (/haciz|tehdit|baskı|eşine|eşime|icra|son tarih|tekrar aran/.test(s) ? 6 : 0) +
    (/ulaşılam|cevap ver|aran|görüş/.test(s) ? 2 : 0) +
    (/yarın|bugün|pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık|\d{1,2}[/.]\d{1,2}/.test(
      s,
    )
      ? 3
      : 0)
  );
}
function fragments(note) {
  // Sentence/clause selection preserves quotations, negations, amounts and dates.
  // Long unpunctuated notes use marked excerpts, never an invented paraphrase.
  return note
    .split(/(?<=[.!?])\s+|[;\n]+/u)
    .flatMap((sentence) => {
      if (Array.from(sentence).length <= 220) return [sentence];
      const words = sentence.split(/\s+/u),
        parts = [];
      for (let start = 0; start < words.length; start += 20)
        parts.push(
          (start ? '…' : '') +
            bounded(words.slice(start, start + 28).join(' '), 200) +
            (start + 28 < words.length ? '…' : ''),
        );
      return parts;
    })
    .map(clean)
    .filter(Boolean);
}
function extractiveSummary(rows) {
  if (!rows.length) return '';
  const latest = rows.at(-1),
    seen = new Set(),
    candidates = [];
  rows.forEach((row, index) =>
    fragments(row.note).forEach((text, position) => {
      const key = text.toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]+/gu, ' ');
      candidates.push({
        text,
        index,
        position,
        key,
        score: importance(text) + (index / Math.max(rows.length, 1)) * 2,
      });
    }),
  );
  // For repeated statements retain the newest occurrence.
  const unique = candidates.reverse().filter((c) => !seen.has(c.key) && seen.add(c.key));
  const latestWithNotes = rows.findLastIndex((r) => r.note);
  const primary = unique
    .filter((c) => c.index === latestWithNotes)
    .sort((a, b) => b.score - a.score || a.position - b.position)[0];
  const selected = [];
  const prefix =
    latest.result && !['Raporlandı', 'Diğer'].includes(latest.result) ? 'Sonuç: ' + latest.result + '. ' : '';
  function render(items) {
    const grouped = new Map();
    for (const item of [...items].sort((a, b) => a.index - b.index || a.position - b.position)) {
      if (!grouped.has(item.index)) grouped.set(item.index, []);
      grouped.get(item.index).push(item.text);
    }
    return (
      prefix +
      [...grouped]
        .map(([index, texts]) => {
          const day = rows[index].date;
          const date = /^\d{4}-\d{2}-\d{2}$/.test(day)
            ? day.slice(8) + '.' + day.slice(5, 7) + '.' + day.slice(0, 4) + ': '
            : '';
          return date + texts.join(' ');
        })
        .join(' ')
    );
  }
  if (primary) selected.push(primary);
  for (const c of unique.sort((a, b) => b.score - a.score || b.index - a.index || a.position - b.position)) {
    if (selected.length >= 3) break;
    if (c === primary || selected.some((x) => x.key.includes(c.key) || c.key.includes(x.key))) continue;
    if (Array.from(render([...selected, c])).length <= 300) selected.push(c);
  }
  return bounded(render(selected) || rows.at(-1).result);
}
async function generateReport(conversations = []) {
  const rows = history(conversations);
  return {
    version: VERSION,
    sourceHash: fingerprint(conversations),
    sourceCount: rows.length,
    generatedAt: new Date().toISOString(),
    method: 'local-extractive',
    text: extractiveSummary(rows),
  };
}
module.exports = { VERSION, fingerprint, currentReport, bounded, generateReport };

(function (root) {
  const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, canonical(value[k])]),
      );
    return value;
  }
  const paths = {
    'icrapro-v1': [['clients'], ['docs']],
    'hanhukuk-finance-v1': [[]],
    'hanhukuk-accounting-v1': [['accounts'], ['entries']],
    'icrapro-personnel-v1': [[]],
    'icrapro-cases-v1': [[]],
  };
  const get = (value, path) => path.reduce((v, k) => v?.[k], value);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fail = (message, status = 400) => Object.assign(Error(message), { status, code: status });
  function map(rows) {
    if (!Array.isArray(rows)) throw fail('Geçersiz kayıt listesi.');
    const out = new Map();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id || out.has(row.id))
        throw fail('Kayıt kimliği eksik veya tekrarlı.');
      out.set(row.id, row);
    }
    return out;
  }
  function diff(key, before, after) {
    if (!paths[key]) return null;
    if (paths[key].every((p) => p.length === 1)) {
      const fields = new Set(paths[key].map((p) => p[0]));
      const rest = (value) =>
        Object.fromEntries(
          Object.entries(value || {}).filter(([k]) => !fields.has(k) && k !== 'archivedNumbers'),
        );
      if (!same(rest(before), rest(after))) return null;
    }
    const changes = [];
    for (const path of paths[key]) {
      const old = map(get(before, path)),
        next = map(get(after, path));
      if (
        !same(
          [...old.keys()].filter((id) => next.has(id)),
          [...next.keys()].filter((id) => old.has(id)),
        )
      )
        return null;
      for (const id of new Set([...old.keys(), ...next.keys()])) {
        const a = old.get(id),
          b = next.get(id);
        if (!a || !b) {
          changes.push({ path, id, before: a ?? null, value: b ?? null });
          continue;
        }
        for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (field === 'id' || same(a[field], b[field])) continue;
          changes.push({
            path,
            id,
            field,
            before: own(a, field) ? { value: a[field] } : {},
            after: own(b, field) ? { value: b[field] } : {},
          });
        }
      }
    }
    return { changes };
  }
  function apply(key, current, patch) {
    if (!paths[key] || !Array.isArray(patch?.changes) || patch.changes.length > 500)
      throw fail('Geçersiz kayıt değişikliği.');
    const value = structuredClone(current),
      seen = new Set();
    for (const change of patch.changes) {
      const { path, id, field } = change;
      if (!paths[key].some((p) => same(p, path)) || typeof id !== 'string' || !id || id.length > 200)
        throw fail('Geçersiz kayıt yolu.');
      if (
        field !== undefined &&
        (typeof field !== 'string' ||
          field === 'id' ||
          ['__proto__', 'prototype', 'constructor'].includes(field))
      )
        throw fail('Geçersiz alan.');
      const identity = JSON.stringify([path, id, field]);
      if (seen.has(identity)) throw fail('Tekrarlı değişiklik.');
      seen.add(identity);
      const rows = get(value, path),
        index = rows.findIndex((r) => r.id === id),
        row = rows[index];
      if (field === undefined) {
        if (!same(row ?? null, change.before))
          throw fail('Kayıt başka bir işlemle değişti. Güncel kaydı yükleyin.', 409);
        if (change.value === null) {
          if (index < 0) throw fail('Kayıt bulunamadı.');
          rows.splice(index, 1);
        } else {
          if (!change.value || change.value.id !== id) throw fail('Geçersiz kayıt kimliği.');
          if (index < 0) rows.push(structuredClone(change.value));
          else rows[index] = structuredClone(change.value);
        }
      } else {
        if (!row || !same(own(row, field) ? { value: row[field] } : {}, change.before))
          throw fail('Alan başka bir işlemle değişti. Güncel kaydı yükleyin.', 409);
        if (!change.after || typeof change.after !== 'object') throw fail('Geçersiz alan değeri.');
        if (own(change.after, 'value')) row[field] = structuredClone(change.after.value);
        else delete row[field];
      }
    }
    return value;
  }
  const api = { diff, apply };
  if (typeof module !== 'undefined') module.exports = api;
  else root.HanRecordPatch = api;
})(globalThis);

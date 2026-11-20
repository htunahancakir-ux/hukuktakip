// Give Turkish-specific letters their own place in lexical order even on a database
// without Turkish ICU collations. C collation also keeps cursor comparisons consistent.
function turkishListKey(expression) {
  let key = `lower(translate(${expression},'Iİ','ıi'))`;
  for (const [letter, after] of [
    ['ç', 'c'],
    ['ğ', 'g'],
    ['ı', 'h'],
    ['ö', 'o'],
    ['ş', 's'],
    ['ü', 'u'],
  ])
    key = `replace(${key},'${letter}','${after}~')`;
  return key;
}

function listSorts(columns) {
  const options = {};
  for (const [name, { expression, type = 'text' }] of Object.entries(columns)) {
    for (const [suffix, direction] of [
      ['Asc', 'ASC'],
      ['Desc', 'DESC'],
    ]) {
      const key =
        type === 'text'
          ? `(coalesce(nullif(${expression},''),${direction === 'ASC' ? 'chr(1114111)' : "''"}) COLLATE "C")`
          : expression;
      options[name + suffix] = { expression: key, type, direction };
    }
  }
  return options;
}

function listPageOrder({ expression, direction, type = 'text' }, id, cursor, params, conditions) {
  if (cursor) {
    const value = '$' + params.push(cursor.value);
    const lastId = '$' + params.push(cursor.id);
    conditions.push(
      `(${expression},${id})${direction === 'ASC' ? '>' : '<'}(${value}::${type},${lastId}::text)`,
    );
  }
  return expression + ' ' + direction + ',' + id + ' ' + direction;
}

function validListSortValue(value, type) {
  return (
    typeof value === 'string' &&
    (type !== 'bigint' ||
      (/^-?\d{1,19}$/.test(value) &&
        BigInt(value) >= -9223372036854775808n &&
        BigInt(value) <= 9223372036854775807n))
  );
}

module.exports = { turkishListKey, listSorts, listPageOrder, validListSortValue };

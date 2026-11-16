const DEFAULTS = Object.freeze([
  'Yönetici',
  'Pazarlama',
  'Callcenter',
  'Call Center-Y',
  'Call Center-E',
  'Muhasebe',
  'İcra',
  'Evrak Takip',
  'Call Center-T',
  'Diğer',
]);
const key = (value) =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('tr');
function canonicalName(value) {
  const name = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
  if (key(name) === 'temlik' || key(name).replace(/[\s_-]/g, '') === 'callcentert') return 'Call Center-T';
  return DEFAULTS.find((item) => key(item) === key(name)) || name;
}
function departments(state) {
  const names = [
    ...DEFAULTS,
    ...(Array.isArray(state.personnelDepartments) ? state.personnelDepartments : []),
    ...(state.data?.['icrapro-personnel-v1'] || []).map((person) => person.department),
  ];
  const seen = new Set();
  return names
    .filter((value) => typeof value === 'string')
    .map(canonicalName)
    .filter((name) => {
      if (!name || seen.has(key(name))) return false;
      seen.add(key(name));
      return true;
    });
}
function validName(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 120 ||
    /[<>\u0000-\u001f\u007f]/u.test(value)
  )
    throw Object.assign(Error('Geçerli bir birim adı girin (en fazla 60 karakter).'), { code: 400 });
  const name = String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length > 60) throw Object.assign(Error('Birim adı en fazla 60 karakter olabilir.'), { code: 400 });
  return name;
}
function catalog(state) {
  const labels =
    state.personnelDepartmentLabels &&
    typeof state.personnelDepartmentLabels === 'object' &&
    !Array.isArray(state.personnelDepartmentLabels)
      ? state.personnelDepartmentLabels
      : {};
  return departments(state).map((id) => ({
    id,
    name: Object.hasOwn(labels, id) && typeof labels[id] === 'string' && labels[id].trim() ? labels[id] : id,
  }));
}
function conflicts(state, name, excluding) {
  return catalog(state).some(
    (unit) =>
      unit.id !== excluding && (key(unit.id) === key(canonicalName(name)) || key(unit.name) === key(name)),
  );
}
function add(state, value) {
  const name = canonicalName(validName(value));
  if (conflicts(state, name)) throw Object.assign(Error('Bu birim zaten mevcut.'), { code: 409 });
  const custom = Array.isArray(state.personnelDepartments) ? state.personnelDepartments : [];
  if (custom.length >= 100)
    throw Object.assign(Error('En fazla 100 ek birim oluşturabilirsiniz.'), { code: 400 });
  state.personnelDepartments = [...custom, name];
  return name;
}
function rename(state, value, nextName, previousName) {
  if (typeof value !== 'string' || value.length > 120)
    throw Object.assign(Error('Düzenlenecek birimi seçin.'), { code: 400 });
  const id = canonicalName(value),
    unit = catalog(state).find((item) => item.id === id);
  if (!unit) throw Object.assign(Error('Birim bulunamadı. Listeyi yenileyin.'), { code: 404 });
  if (previousName !== undefined && previousName !== unit.name)
    throw Object.assign(Error('Birim adı başka bir işlemde değişti. Listeyi yenileyin.'), { code: 409 });
  const name = validName(nextName);
  if (conflicts(state, name, id))
    throw Object.assign(Error('Bu birim adı zaten kullanılıyor.'), { code: 409 });
  // Change the display name only: personnel, payroll and permissions retain their stable unit.
  const prior = state.personnelDepartmentLabels;
  const labels = { ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}) };
  if (name === id) delete labels[id];
  else
    Object.defineProperty(labels, id, { value: name, enumerable: true, configurable: true, writable: true });
  state.personnelDepartmentLabels = labels;
  return { id, name };
}
module.exports = { DEFAULTS, canonicalName, departments, catalog, add, rename };

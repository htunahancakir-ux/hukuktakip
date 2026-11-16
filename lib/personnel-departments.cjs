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
function add(state, value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 120 ||
    /[<>\u0000-\u001f\u007f]/u.test(value)
  )
    throw Object.assign(Error('Geçerli bir birim adı girin (en fazla 60 karakter).'), { code: 400 });
  const name = canonicalName(value);
  if (name.length > 60) throw Object.assign(Error('Birim adı en fazla 60 karakter olabilir.'), { code: 400 });
  if (departments(state).some((existing) => key(existing) === key(name)))
    throw Object.assign(Error('Bu birim zaten mevcut.'), { code: 409 });
  const custom = Array.isArray(state.personnelDepartments) ? state.personnelDepartments : [];
  if (custom.length >= 100)
    throw Object.assign(Error('En fazla 100 ek birim oluşturabilirsiniz.'), { code: 400 });
  state.personnelDepartments = [...custom, name];
  return name;
}
module.exports = { DEFAULTS, canonicalName, departments, add };

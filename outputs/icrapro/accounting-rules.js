(function (root) {
  const expenseCategoryAliases = Object.freeze({
    Yemek: 'Mutfak',
    'Yemek Gideri': 'Mutfak',
    'Mutfak Gideri': 'Mutfak',
    'Banka Gideri': 'Banka',
    'İcra Giderleri': 'İcra',
    'Kargo Giderleri': 'Kargo',
    'Ashan Giderleri': 'Ashan',
    'Araç Gideri': 'Araç',
    'Araştırma Gideri': 'Araştırma',
    'Ofis Giderleri': 'Ofis',
    'Yediemin Gideri': 'Yediemin',
  });
  const rules = {
    expenseCategoryAliases,
    expenseCategoryName: (value) =>
      Object.hasOwn(expenseCategoryAliases, value) ? expenseCategoryAliases[value] : value,
    expenseCategories: Object.freeze([
      'Masraf',
      'Faturalar',
      'Banka',
      'İcra',
      'Kargo',
      'Araç',
      'Araştırma',
      'Yakıt',
      'SGK',
      'Maaş',
      'Maaş Avansı',
      'Prim',
      'Kira',
      'Vergi',
      'Ofis',
      'Yediemin',
      'Mutfak',
      'Ulaşım',
      'Diğer',
    ]),
  };
  if (typeof module !== 'undefined') module.exports = rules;
  else root.hanAccountingRules = rules;
})(typeof window === 'undefined' ? {} : window);

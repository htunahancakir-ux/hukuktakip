(function (root) {
  const expenseCategoryAliases = Object.freeze({ Yemek: 'Mutfak Gideri', 'Yemek Gideri': 'Mutfak Gideri' });
  const rules = {
    expenseCategoryAliases,
    expenseCategoryName: (value) =>
      Object.hasOwn(expenseCategoryAliases, value) ? expenseCategoryAliases[value] : value,
    expenseCategories: Object.freeze([
      'Masraf',
      'Faturalar',
      'Banka Gideri',
      'İcra Giderleri',
      'Kargo Giderleri',
      'Ashan Giderleri',
      'İstihbarat Gideri',
      'Araştırma Gideri',
      'Yakıt',
      'SGK',
      'Maaş',
      'Maaş Avansı',
      'Prim',
      'Kira',
      'Vergi',
      'Ofis Giderleri',
      'Yediemin Gideri',
      'Mutfak Gideri',
      'Ulaşım',
      'Diğer',
    ]),
  };
  if (typeof module !== 'undefined') module.exports = rules;
  else root.hanAccountingRules = rules;
})(typeof window === 'undefined' ? {} : window);

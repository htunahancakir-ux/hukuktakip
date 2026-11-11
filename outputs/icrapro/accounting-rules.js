(function (root) {
  const rules = {
    expenseCategories: Object.freeze([
      'Masraf',
      'Faturalar',
      'Yakıt',
      'SGK',
      'Maaş',
      'Maaş Avansı',
      'Prim',
      'Kira',
      'Vergi',
      'Ofis Giderleri',
      'Yediemin Gideri',
      'Yemek',
      'Ulaşım',
      'Diğer',
    ]),
  };
  if (typeof module !== 'undefined') module.exports = rules;
  else root.hanAccountingRules = rules;
})(typeof window === 'undefined' ? {} : window);

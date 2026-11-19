(function (root) {
  const names = Object.freeze(['Ort.Kardnz', 'Bt.Krdnz', 'Marmara', 'Bursa']);
  const valid = (value) => value === '' || names.includes(value);
  const api = Object.freeze({ names, valid });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HanDebtorFolders = api;
})(typeof window === 'undefined' ? globalThis : window);

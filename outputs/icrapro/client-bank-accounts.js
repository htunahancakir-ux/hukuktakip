(function (root) {
  const fields = ['bankName', 'bankBranch', 'accountHolder', 'iban'];
  function validIban(value) {
    value = String(value || '')
      .replace(/\s/g, '')
      .toUpperCase();
    if (!value) return true;
    if (!/^TR\d{24}$/.test(value)) return false;
    let remainder = 0;
    for (const char of value.slice(4) + value.slice(0, 4)) {
      const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
      for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder === 1;
  }
  function additional(record) {
    const fail = (message) => {
      throw Object.assign(Error(message), { code: 400 });
    };
    const rows = record.additionalBankAccounts;
    if (rows === undefined) return [];
    if (!Array.isArray(rows) || rows.length > 2)
      fail('Müvekkile toplam en fazla 3 banka hesabı eklenebilir.');
    const ibans = new Set(
      [
        String(record.iban || '')
          .replace(/\s/g, '')
          .toUpperCase(),
      ].filter(Boolean),
    );
    return rows
      .map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Geçersiz banka hesabı.');
        const account = {};
        for (const field of fields) {
          if (row[field] != null && typeof row[field] !== 'string') fail('Geçersiz banka bilgisi.');
          account[field] = String(row[field] || '').trim();
          if (account[field].length > (field === 'iban' ? 40 : 200)) fail('Banka bilgisi çok uzun.');
        }
        account.iban = account.iban.replace(/\s/g, '').toUpperCase();
        if (!validIban(account.iban)) fail('Ek banka hesabı için geçerli bir Türkiye IBAN numarası girin.');
        if (account.iban && ibans.has(account.iban)) fail('Aynı IBAN birden fazla banka hesabına eklenemez.');
        if (account.iban) ibans.add(account.iban);
        return account;
      })
      .filter((account) => fields.some((field) => account[field]));
  }
  const api = { fields, validIban, additional };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HanClientBanks = api;
})(typeof window !== 'undefined' ? window : this);

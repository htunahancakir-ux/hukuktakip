// Party name comparison shared by the browser and the server's conflict check.
(function (root) {
  // Company suffixes and connectives that do not identify a party.
  const noise = new Set([
    'as',
    'anonim',
    'sirketi',
    'sirket',
    'ltd',
    'sti',
    'limited',
    'tic',
    'ticaret',
    'san',
    'sanayi',
    've',
    'ith',
    'ihr',
  ]);

  function normalizePartyName(value) {
    return String(value ?? '')
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function partyTokens(value) {
    return [
      ...new Set(
        normalizePartyName(value)
          .split(' ')
          .filter((token) => token.length > 1 && !noise.has(token)),
      ),
    ];
  }

  // 'exact' when both names carry the same words; 'partial' when every word of the shorter
  // name (at least two words) appears in the longer one; otherwise null.
  function partyNamesMatch(a, b) {
    const left = partyTokens(a),
      right = partyTokens(b);
    if (!left.length || !right.length) return null;
    const [short, long] = left.length <= right.length ? [left, right] : [right, left],
      words = new Set(long);
    if (!short.every((token) => words.has(token))) return null;
    if (short.length === long.length) return 'exact';
    return short.length > 1 ? 'partial' : null;
  }

  // Turkish identity or tax number without spaces; '' when it is not one.
  function partyIdentity(value) {
    const key = String(value ?? '').replace(/\s/g, '');
    return /^\d{10,11}$/.test(key) ? key : '';
  }

  const api = { normalizePartyName, partyTokens, partyNamesMatch, partyIdentity };
  if (typeof module !== 'undefined') module.exports = api;
  else root.hanPartyName = api;
})(typeof window === 'undefined' ? {} : window);

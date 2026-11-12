(function (root) {
  function formatPhoneNumber(value) {
    const original = String(value || '').trim();
    if (!original) return '';
    let digits = original.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('90')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length !== 10) return original;
    return (
      '0 (' +
      digits.slice(0, 3) +
      ') ' +
      digits.slice(3, 6) +
      ' ' +
      digits.slice(6, 8) +
      ' ' +
      digits.slice(8)
    );
  }
  function formatIbanNumber(value) {
    return (
      String(value || '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .match(/.{1,4}/g)
        ?.join(' ') || ''
    );
  }

  function phoneSourceKey(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('90')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return digits;
  }
  function cleanPhoneSources(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [number, source] of Object.entries(value)) {
      const key = phoneSourceKey(number);
      if (/^\d{7,15}$/.test(key) && typeof source === 'string' && source.trim())
        out[key] = source.trim().slice(0, 200);
    }
    return out;
  }
  function phoneSource(record, number) {
    return cleanPhoneSources(record && record.phoneSources)[phoneSourceKey(number)] || '';
  }
  // Bind the annotation to the input's number, rather than its Tel-N position.
  function bindPhoneSource(form, input, record = {}) {
    if (!input || input._phoneSourceInput) return;
    if (!form._phoneSourceBase) form._phoneSourceBase = cleanPhoneSources(record.phoneSources);
    if (!form._phoneSourceInitial) form._phoneSourceInitial = new Set();
    form._phoneSourceInitial.add(phoneSourceKey(input.value));
    const label = input.closest('label');
    if (!label) return;
    const pair = input.ownerDocument.createElement('div');
    pair.className = 'full phone-source-pair';
    label.before(pair);
    pair.append(label);
    const sourceLabel = input.ownerDocument.createElement('label');
    sourceLabel.className = 'field';
    sourceLabel.textContent = 'Kaynak / Kime Ait (isteğe bağlı)';
    const source = input.ownerDocument.createElement('input');
    source.type = 'text';
    source.maxLength = 200;
    source.dataset.optional = 'true';
    source.dataset.phoneSource = 'true';
    source.autocomplete = 'off';
    source.value = phoneSource(record, input.value);
    source.placeholder = 'Örn. Eşi Ayşe / iş yeri';
    input._phoneSourceInput = source;
    sourceLabel.append(source);
    pair.append(sourceLabel);
  }
  function setupPhoneSources(form, record = {}) {
    for (const input of form.querySelectorAll('input[type="tel"]')) bindPhoneSource(form, input, record);
  }
  function readPhoneSources(form) {
    const sources = { ...(form._phoneSourceBase || {}) };
    for (const key of form._phoneSourceInitial || []) delete sources[key];
    for (const input of form.querySelectorAll('input[type="tel"]')) {
      const key = phoneSourceKey(input.value),
        source = input._phoneSourceInput?.value.trim();
      if (key && source) sources[key] = source;
    }
    return cleanPhoneSources(sources);
  }

  function normalizePhoneRecords(value) {
    if (!value || typeof value !== 'object') return value;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'phoneSources') value[key] = cleanPhoneSources(item);
      else if (/iban/i.test(key) && typeof item === 'string') value[key] = formatIbanNumber(item);
      else if (key === 'additionalPhones' && Array.isArray(item)) value[key] = item.map(formatPhoneNumber);
      else if (
        /^(phone\d*|referencePhone\d*|officePhone\d*|tel\d*|telephone)$/i.test(key) &&
        typeof item === 'string'
      )
        value[key] = formatPhoneNumber(item);
      else if (item && typeof item === 'object') normalizePhoneRecords(item);
    }
    return value;
  }
  // A debtor's own numbers fill Tel-1 and Tel-2 first; further ones are Tel-3, Tel-4… (additionalPhones).
  function borrowerPhoneSlots(doc) {
    const seen = new Set(),
      list = [];
    for (const value of [
      doc && doc.phone1,
      doc && doc.phone2,
      ...(doc && Array.isArray(doc.additionalPhones) ? doc.additionalPhones : []),
    ]) {
      const text = String(value || '').trim(),
        key = text.replace(/\D/g, '').replace(/^(90|0)(?=[1-9]\d{9}$)/, '');
      if (!text || seen.has(key)) continue;
      seen.add(key);
      list.push(text);
    }
    return { phone1: list[0] || '', phone2: list[1] || '', additionalPhones: list.slice(2) };
  }
  if (typeof module !== 'undefined' && module.exports)
    module.exports = {
      formatPhoneNumber,
      normalizePhoneRecords,
      formatIbanNumber,
      borrowerPhoneSlots,
      phoneSourceKey,
      cleanPhoneSources,
      phoneSource,
      bindPhoneSource,
      setupPhoneSources,
      readPhoneSources,
    };
  else {
    Object.assign(root, {
      phoneSourceKey,
      cleanPhoneSources,
      phoneSource,
      bindPhoneSource,
      setupPhoneSources,
      readPhoneSources,
    });
    root.borrowerPhoneSlots = borrowerPhoneSlots;
    root.formatIbanNumber = formatIbanNumber;
    root.formatPhoneNumber = formatPhoneNumber;
    root.normalizePhoneRecords = normalizePhoneRecords;
  }
})(typeof window !== 'undefined' ? window : this);

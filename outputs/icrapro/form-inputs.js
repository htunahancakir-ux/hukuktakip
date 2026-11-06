function field(label, name, type = 'text', value = '', required = false, full = false) {
  return `<label class="field ${full ? 'full' : ''}">${label}${required ? ' *' : ''}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${name === 'identity' ? 'inputmode="numeric" pattern="[0-9]{10,11}" title="10 veya 11 rakam girin"' : ''} ${name === 'amount' ? 'min="0.01" step="0.01"' : ''}></label>`;
}

function displayDate(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.split('-').reverse().join('/');
  if (/^\d{4}-\d{2}$/.test(text)) return text.slice(5) + '/' + text.slice(0, 4);
  return text;
}

function parseDisplayDate(value, kind) {
  let text = String(value || '')
    .trim()
    .replace(/[.\-]/g, '/');
  if (['bugün', 'bugun'].includes(text.toLocaleLowerCase('tr'))) {
    const today = businessDate();
    return kind === 'month' ? today.slice(0, 7) : today;
  }
  if (/^\d+$/.test(text)) {
    if (kind === 'month') {
      if (text.length === 5) text = '0' + text;
      if (text.length === 6) text = text.slice(0, 2) + '/' + text.slice(2);
    } else {
      if (text.length === 6) text = '0' + text[0] + '/0' + text[1] + '/' + text.slice(2);
      else if (text.length === 8) text = text.slice(0, 2) + '/' + text.slice(2, 4) + '/' + text.slice(4);
      else if (text.length === 7) {
        const year = text.slice(3),
          candidates = [
            text.slice(0, 2) + '/' + text[2] + '/' + year,
            text[0] + '/' + text.slice(1, 3) + '/' + year,
          ];
        for (const candidate of candidates) {
          const parsed = parseDisplayDate(candidate, kind);
          if (parsed) return parsed;
        }
        return '';
      }
    }
  }
  if (kind === 'month') {
    const match = text.match(/^(\d{1,2})\/(\d{4})$/);
    if (!match || +match[1] < 1 || +match[1] > 12) return '';
    return match[2] + '-' + match[1].padStart(2, '0');
  }
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return '';
  const iso = match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0'),
    stamp = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === iso ? iso : '';
}

function upgradeDateInputs() {
  document.querySelectorAll('input[type="date"],input[type="month"]').forEach((original) => {
    if (original.dataset.dateUi) return;
    const kind = original.type,
      proxy = document.createElement('input');
    original.dataset.dateUi = kind;
    proxy.type = 'text';
    proxy.inputMode = 'text';
    proxy.autocomplete = 'off';
    proxy.dataset.optional = 'true';
    proxy.placeholder = kind === 'month' ? 'AA/YYYY veya bugün' : 'GG/AA/YYYY veya bugün';
    proxy.title = 'Rakamla tarih yazabilirsiniz: 112020, 25032026. Bugün için bugün yazın.';
    proxy.maxLength = kind === 'month' ? 7 : 10;
    proxy.required = original.required;
    proxy.readOnly = original.readOnly;
    proxy.disabled = original.disabled;
    proxy.value = displayDate(original.value);
    proxy.setAttribute(
      'aria-label',
      (original.getAttribute('aria-label') ||
        original.closest('label')?.childNodes[0]?.textContent?.trim() ||
        'Tarih') +
        ' (' +
        (kind === 'month' ? 'ay/yıl' : 'gün/ay/yıl') +
        ')',
    );
    original.before(proxy);
    original.type = 'hidden';
    function update() {
      const value = parseDisplayDate(proxy.value, kind);
      original.value = value;
      proxy.setCustomValidity(
        proxy.value && !value
          ? kind === 'month'
            ? 'Ay/yıl biçiminde geçerli tarih girin (10/2026).'
            : 'Gün/ay/yıl biçiminde geçerli tarih girin (29/10/2026).'
          : '',
      );
      if (value && original.min && value < original.min)
        proxy.setCustomValidity('Tarih izin verilen aralıktan önce.');
      if (value && original.max && value > original.max)
        proxy.setCustomValidity('Tarih izin verilen aralıktan sonra.');
    }
    proxy.addEventListener('input', update);
    proxy.addEventListener('change', () => {
      update();
      if (!proxy.validity.valid) return;
      proxy.value = displayDate(original.value);
      original.dispatchEvent(new Event('change', { bubbles: true }));
    });
    original.addEventListener('change', () => {
      proxy.value = displayDate(original.value);
    });
    original.form?.addEventListener('reset', () =>
      queueMicrotask(() => {
        proxy.value = displayDate(original.value);
        proxy.setCustomValidity('');
      }),
    );
    original._dateProxy = proxy;
    setupDateCalendar(original, proxy, kind);
  });
  document.querySelectorAll('input[data-date-ui]').forEach((original) => {
    const proxy = original._dateProxy;
    if (proxy) {
      proxy.required = original.required;
      proxy.readOnly = original.readOnly;
      proxy.disabled = original.disabled;
      if (original._calendarButton)
        original._calendarButton.disabled = original.disabled || original.readOnly;
      if (original._calendarPicker)
        original._calendarPicker.disabled = original.disabled || original.readOnly;
    }
  });
}

function formatAmountInput(value) {
  if (value === '' || value == null) return '';
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)
    : '';
}

function parseAmountInput(value) {
  const text = String(value).trim().replace(/\s/g, '');
  if (!text) return '';
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{0,2})?$/.test(text)) return null;
  const number = Number(text.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(number) ? String(number) : null;
}

function upgradeMoneyInputs() {
  const names = [
    'amount',
    'preTrackingPayment',
    'principal',
    'interest',
    'fee',
    'officialSalary',
    'unofficialSalary',
    'bonus',
    'notifiedAmount',
  ];
  document.querySelectorAll('input[type="number"]').forEach((original) => {
    if (!names.includes(original.name) || original.dataset.moneyUi) return;
    const proxy = document.createElement('input');
    original.dataset.moneyUi = 'true';
    proxy.type = 'text';
    proxy.inputMode = 'decimal';
    proxy.autocomplete = 'off';
    proxy.dataset.optional = 'true';
    proxy.placeholder = '0,00';
    proxy.value = formatAmountInput(original.value);
    proxy.required = original.required;
    proxy.readOnly = original.readOnly;
    proxy.disabled = original.disabled;
    proxy.setAttribute(
      'aria-label',
      (original.closest('label')?.firstChild?.textContent?.trim() || 'Tutar') +
        ' (TL, kuruş virgülden sonra)',
    );
    original.before(proxy);
    original.type = 'hidden';
    original._moneyProxy = proxy;
    function update() {
      const parsed = parseAmountInput(proxy.value);
      original.value = parsed ?? '';
      let error =
        parsed === null ? 'Tutarı 1.234,56 biçiminde girin; en fazla iki kuruş hanesi kullanın.' : '';
      if (parsed !== null && parsed !== '') {
        if (original.min !== '' && Number(parsed) < Number(original.min))
          error = 'Tutar en az ' + formatAmountInput(original.min) + ' TL olmalıdır.';
        if (original.max !== '' && Number(parsed) > Number(original.max))
          error = 'Tutar en fazla ' + formatAmountInput(original.max) + ' TL olabilir.';
        if (!Number.isSafeInteger(Math.round(Number(parsed) * 100))) error = 'Tutar çok büyük.';
      }
      proxy.setCustomValidity(error);
      return !error;
    }
    proxy.addEventListener('input', update);
    proxy.addEventListener('blur', () => {
      if (update()) proxy.value = formatAmountInput(original.value);
    });
    proxy.addEventListener('change', () => {
      if (update()) original.dispatchEvent(new Event('change', { bubbles: true }));
    });
    original.form?.addEventListener('reset', () =>
      queueMicrotask(() => {
        proxy.value = formatAmountInput(original.value);
        proxy.setCustomValidity('');
      }),
    );
  });
  document.querySelectorAll('input[data-money-ui]').forEach((original) => {
    if (original._moneyProxy) {
      original._moneyProxy.required = original.required;
      original._moneyProxy.readOnly = original.readOnly;
      original._moneyProxy.disabled = original.disabled;
    }
  });
}

function alignCloseButtons() {
  document.querySelectorAll('button').forEach((button) => {
    const text = button.textContent.trim().toLocaleLowerCase('tr');
    if (text === 'kapat' || ((text === '✕' || text === '×') && /close/i.test(button.id))) {
      button.classList.add('close-align-right');
      if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', 'Kapat');
    }
  });
}

function setupDateCalendar(original, proxy, kind) {
  const wrap = document.createElement('span');
  wrap.className = 'date-calendar-control';
  proxy.before(wrap);
  wrap.append(proxy);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'date-calendar-button';
  button.textContent = '▦';
  button.setAttribute('aria-label', kind === 'month' ? 'Ay takvimini aç' : 'Takvimi aç');
  button.title = 'Takvimden seç';
  const picker = document.createElement('input');
  picker.type = kind;
  picker.dataset.dateUi = 'calendar';
  picker.dataset.optional = 'true';
  picker.className = 'date-calendar-native';
  picker.tabIndex = -1;
  picker.setAttribute('aria-label', kind === 'month' ? 'Takvimden ay seç' : 'Takvimden tarih seç');
  wrap.append(button, picker);
  function open() {
    if (original.disabled || original.readOnly) return;
    picker.value = original.value;
    picker.min = original.min || '';
    picker.max = original.max || '';
    picker.disabled = false;
    try {
      if (picker.showPicker) picker.showPicker();
      else {
        picker.classList.add('calendar-fallback');
        picker.focus();
        picker.click();
      }
    } catch {
      picker.classList.add('calendar-fallback');
      picker.focus();
    }
  }
  button.onclick = open;
  const manualDateEntry =
    (original.name === 'issued' && original.form?.id === 'intakeForm') ||
    (original.name === 'date' && original.form?.id === 'financeEntry');
  if (!manualDateEntry) proxy.addEventListener('click', open);
  picker.addEventListener('change', () => {
    original.value = picker.value;
    proxy.value = displayDate(picker.value);
    proxy.setCustomValidity('');
    picker.classList.remove('calendar-fallback');
    original.dispatchEvent(new Event('change', { bubbles: true }));
  });
  original._calendarButton = button;
  original._calendarPicker = picker;
  button.disabled = original.disabled || original.readOnly;
  picker.disabled = button.disabled;
}

function upgradePhoneInputs() {
  document.querySelectorAll('input[type="tel"],input[name]').forEach((input) => {
    if (
      input.closest('#borrowerFilterForm') ||
      input.type === 'search' ||
      !(
        /^tel$/.test(input.type) ||
        /^(phone\d*|referencePhone\d*|officePhone\d*|telephone)$/i.test(input.name)
      )
    )
      return;
    if (!input.dataset.phoneFormat) {
      input.dataset.phoneFormat = 'true';
      input.placeholder = '0 (545) 967 29 77';
      input.inputMode = 'tel';
      input.addEventListener('blur', () => (input.value = formatPhoneNumber(input.value)));
      input.addEventListener('change', () => (input.value = formatPhoneNumber(input.value)));
      input.addEventListener('input', () => {
        let digits = input.value.replace(/\D/g, '');
        if (
          (digits.length === 10 && !digits.startsWith('0')) ||
          (digits.length === 11 && digits.startsWith('0')) ||
          (digits.length === 12 && digits.startsWith('90'))
        )
          input.value = formatPhoneNumber(input.value);
      });
    }
    if (document.activeElement !== input) input.value = formatPhoneNumber(input.value);
  });
}

function upgradeIbanInputs() {
  document.querySelectorAll('input[name]').forEach((input) => {
    if (!/iban/i.test(input.name)) return;
    if (!input.dataset.ibanFormat) {
      input.dataset.ibanFormat = 'true';
      input.maxLength = 42;
      input.placeholder = 'TR00 0000 0000 0000 0000 0000 00';
      input.addEventListener('input', () => {
        const end = input.selectionStart === input.value.length;
        const value = formatIbanNumber(input.value);
        if (input.value !== value) {
          input.value = value;
          if (end) input.setSelectionRange(value.length, value.length);
        }
      });
      input.addEventListener('blur', () => (input.value = formatIbanNumber(input.value)));
    }
    if (document.activeElement !== input) input.value = formatIbanNumber(input.value);
  });
}

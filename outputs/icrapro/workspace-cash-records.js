function bindRecordCashSubmit(form, { dialog, onSaved } = {}) {
  const requestId = crypto.randomUUID();
  let pending = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    const button = form.querySelector('button.primary'),
      screen = $('#content').firstElementChild;
    try {
      const value = Object.fromEntries(new FormData(form));
      value.amount = financeCents(value.amount);
      if (!Number.isSafeInteger(value.amount) || value.amount <= 0) throw Error('Geçerli tutar girin.');
      legalDate(value.date);
      pending = true;
      button.disabled = true;
      const response = await fetch('/api/cash-entry', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Han-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...value, id: requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Para hareketi kaydedilemedi.');
      if (result.accountBalances) window.hanAccountBalances = result.accountBalances;
      dialog?.close();
      toast('Para hareketi kaydedildi.');
      if (screen?.isConnected) onSaved?.();
    } catch (error) {
      toast(error.message);
    } finally {
      pending = false;
      button.disabled = false;
    }
  };
}

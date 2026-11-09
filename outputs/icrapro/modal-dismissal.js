(() => {
  const snapshots = new WeakMap();
  const submitting = new WeakSet();
  const committed = new WeakSet();
  let press = null;
  let warning = null;

  function submitters(form) {
    return Array.from(form.elements).filter(
      (el) =>
        (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) &&
        el.type === 'submit' &&
        !el.matches(':disabled'),
    );
  }

  function fields(form) {
    return Array.from(form.elements).filter(
      (el) =>
        el.matches('input, textarea, select') &&
        !el.matches(':disabled, [readonly], [data-ignore-dirty]') &&
        !['hidden', 'button', 'reset', 'submit', 'image', 'search'].includes(el.type),
    );
  }

  function value(el) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    if (el.type === 'file')
      return JSON.stringify(Array.from(el.files, (f) => [f.name, f.size, f.lastModified]));
    if (el.multiple && el.selectedOptions)
      return JSON.stringify(Array.from(el.selectedOptions, (option) => option.value));
    return el.value;
  }

  function remember(form) {
    snapshots.set(form, new Map(fields(form).map((el) => [el, value(el)])));
  }

  function changed(form) {
    const baseline = snapshots.get(form);
    return (
      !!baseline &&
      (form.dataset.modalDirty === 'true' ||
        fields(form).some((el) => baseline.has(el) && value(el) !== baseline.get(el)))
    );
  }

  function editableForms(dialog) {
    return Array.from(dialog.querySelectorAll('form')).filter(
      (form) =>
        form.closest('dialog') === dialog &&
        form.getAttribute('method') !== 'dialog' &&
        (form.onsubmit || form.hasAttribute('data-track-draft')) &&
        !form.matches('[data-ignore-dirty]'),
    );
  }

  function rememberForms(dialog, reset = false) {
    for (const form of editableForms(dialog)) {
      if (reset || !snapshots.has(form)) remember(form);
      else
        for (const el of fields(form))
          if (!snapshots.get(form).has(el)) snapshots.get(form).set(el, value(el));
    }
  }

  window.modalDrafts = (dialog, except) =>
    editableForms(dialog).filter((form) => form !== except && changed(form));
  window.modalFormSaved = (form) => {
    committed.add(form);
    delete form.dataset.modalDirty;
    remember(form);
  };

  new MutationObserver((mutations) => {
    const refresh = new Set();
    for (const entry of mutations) {
      if (entry.type === 'attributes' && entry.target.matches('dialog[open]')) {
        rememberForms(entry.target, true);
      } else if (entry.type === 'childList') {
        const parent = entry.target instanceof Element && entry.target.closest('dialog[open]');
        if (parent) refresh.add(parent);
        for (const el of entry.addedNodes) {
          if (!(el instanceof Element)) continue;
          if (el.matches('dialog[open]')) refresh.add(el);
          for (const dialog of el.querySelectorAll('dialog[open]')) refresh.add(dialog);
        }
      }
    }
    for (const dialog of refresh) rememberForms(dialog);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });

  function reveal(form) {
    const panel = form.closest('[data-borrower-panel][hidden]');
    if (panel)
      form
        .closest('dialog')
        .querySelector('[data-borrower-tab="' + panel.dataset.borrowerPanel + '"]')
        ?.click();
  }

  async function save(form, submitter) {
    committed.delete(form);
    const original = form.onsubmit;
    let ran = false;
    let result;
    if (original)
      form.onsubmit = function (event) {
        ran = true;
        result = original.call(this, event);
        return result;
      };
    else
      form.addEventListener(
        'submit',
        () => {
          ran = true;
        },
        { once: true },
      );
    submitting.add(form);
    try {
      form.requestSubmit(submitter);
      await result;
      return ran && (committed.has(form) || !form.isConnected || !changed(form));
    } finally {
      if (original && form.onsubmit !== original) form.onsubmit = original;
      submitting.delete(form);
    }
  }

  function dismiss(dialog) {
    if (
      !dialog.open ||
      warning ||
      editableForms(dialog).some(
        (form) =>
          submitting.has(form) ||
          (changed(form) &&
            !submitters(form).length &&
            form.querySelector('button:disabled[type="submit"], button.primary:disabled')),
      )
    )
      return;
    const drafts = window.modalDrafts(dialog);
    if (!drafts.length) return dialog.close();
    const prompt = document.createElement('dialog');
    warning = prompt;
    prompt.className = 'unsaved-modal';
    prompt.setAttribute('aria-labelledby', 'unsavedModalTitle');
    prompt.innerHTML =
      '<div class="panelhead"><h2 id="unsavedModalTitle">Kaydedilmemiş değişiklikler</h2></div>' +
      '<div class="formbody"><p>Değişiklik yaptınız. Kapatmadan önce kaydetmek istiyor musunuz?</p>' +
      (drafts.length > 1
        ? '<p>Birden fazla form değişti. Önce birini kaydedin veya düzenlemeye dönün.</p>'
        : '') +
      '</div><div class="actions"><button type="button" class="secondary" data-edit autofocus>Düzenlemeye dön</button>' +
      '<button type="button" class="secondary" data-discard>Kaydetmeden kapat</button><button type="button" class="primary" data-save>Kaydet</button></div>';
    document.body.append(prompt);
    prompt.addEventListener(
      'close',
      () => {
        prompt.remove();
        if (warning === prompt) warning = null;
      },
      { once: true },
    );
    prompt.querySelector('[data-edit]').onclick = () => prompt.close();
    prompt.querySelector('[data-discard]').onclick = () => {
      prompt.close();
      dialog.close();
    };
    const button = prompt.querySelector('[data-save]');
    const form = drafts[0];
    const submitter = submitters(form)[0];
    if (drafts.length > 1) button.textContent = 'İlk formu kaydet';
    button.disabled = !submitter;
    button.onclick = async () => {
      prompt.close();
      reveal(form);
      const existing = new Set(document.querySelectorAll('dialog[open]'));
      try {
        if (
          (await save(form, submitter)) &&
          dialog.open &&
          !window.modalDrafts(dialog).length &&
          !Array.from(document.querySelectorAll('dialog[open]')).some((item) => !existing.has(item))
        ) {
          dialog.close();
        }
      } catch (error) {
        if (typeof toast === 'function') toast(error.message || 'Değişiklikler kaydedilemedi.', dialog);
      }
    };
    prompt.showModal();
  }

  const activeModal = (event) =>
    event.target.closest?.('dialog[open]:modal') ||
    (!document.querySelector('dialog[open]:modal') && document.querySelector('#borrowerDetail[open]'));
  const outside = (event, dialog) => {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
  };
  document.addEventListener(
    'pointerdown',
    (event) => {
      press = null;
      const dialog = activeModal(event);
      if (dialog && dialog !== warning && event.button === 0 && outside(event, dialog)) press = dialog;
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const dialog = activeModal(event);
      const wasOutside = press === dialog;
      press = null;
      if (!dialog || dialog === warning) return;
      const close = event.target.closest?.('button');
      const closeButton =
        close?.closest('dialog') === dialog &&
        !close.closest('[data-modal-layer]') &&
        ['Kapat', 'Vazgeç', 'İptal'].includes(close.textContent.trim());
      if (!(closeButton || (event.detail && wasOutside && outside(event, dialog)))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss(dialog);
    },
    true,
  );
  document.addEventListener(
    'cancel',
    (event) => {
      if (!event.target.matches('dialog') || event.target === warning) return;
      event.preventDefault();
      const layer = event.target.querySelector('[data-modal-layer]:not([hidden])');
      if (layer) {
        layer.dispatchEvent(new Event('modal-layer-dismiss'));
        return;
      }
      dismiss(event.target);
    },
    true,
  );
})();

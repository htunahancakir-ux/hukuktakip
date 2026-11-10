(() => {
  const snapshots = new WeakMap();
  let press = null;

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

  function dismiss(dialog) {
    if (dialog.open) dialog.close();
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
      if (dialog && event.button === 0 && outside(event, dialog)) press = dialog;
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const dialog = activeModal(event);
      const wasOutside = press === dialog;
      press = null;
      if (!dialog) return;
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
      if (!event.target.matches('dialog')) return;
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

// Shared dragging for existing and dynamically created dialog windows.
(() => {
  const moved = new Map();
  let drag = null;
  function decorate(dialog) {
    if (!dialog.open) return;
    const header = dialog.querySelector('.panelhead, .terms-gate-head') || dialog.querySelector('h1,h2,h3');
    if (header && header.closest('dialog') === dialog) header.classList.add('modal-drag-handle');
  }
  function stop() {
    if (!drag) return;
    const { dialog, header, pointerId } = drag;
    drag = null;
    dialog.classList.remove('modal-dragging');
    try {
      if (header.hasPointerCapture?.(pointerId)) header.releasePointerCapture(pointerId);
    } catch {}
  }
  function reset(dialog) {
    if (drag?.dialog === dialog) stop();
    const state = moved.get(dialog);
    if (!state) return;
    if (state.original) dialog.style.setProperty('translate', state.original, state.priority);
    else dialog.style.removeProperty('translate');
    moved.delete(dialog);
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    const header = event.target.closest?.('.modal-drag-handle');
    const dialog = header?.closest('dialog[open]');
    if (
      !dialog ||
      event.target.closest('button,a,input,select,textarea,label,[contenteditable="true"],[role="button"]')
    )
      return;
    event.preventDefault();
    let state = moved.get(dialog);
    if (!state) {
      const value = getComputedStyle(dialog).translate;
      const parts = value && value !== 'none' ? value.split(/\s+/) : ['0', '0'];
      const rect = dialog.getBoundingClientRect();
      const pixels = (v, size) => (parseFloat(v) || 0) * (v?.endsWith('%') ? size / 100 : 1);
      state = {
        x: pixels(parts[0], rect.width),
        y: pixels(parts[1], rect.height),
        original: dialog.style.getPropertyValue('translate'),
        priority: dialog.style.getPropertyPriority('translate'),
      };
      moved.set(dialog, state);
    }
    drag = {
      dialog,
      header,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: state.x,
      startY: state.y,
      rect: header.getBoundingClientRect(),
      state,
    };
    dialog.classList.add('modal-dragging');
    try {
      header.setPointerCapture(event.pointerId);
    } catch {}
  });
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.dialog.open || !drag.dialog.isConnected) {
        reset(drag.dialog);
        return;
      }
      event.preventDefault();
      const { rect, state } = drag;
      // Keep enough of the title bar visible to retrieve the window.
      const dx = Math.max(96 - rect.right, Math.min(innerWidth - 96 - rect.left, event.clientX - drag.x));
      const dy = Math.max(8 - rect.top, Math.min(innerHeight - 40 - rect.top, event.clientY - drag.y));
      state.x = drag.startX + dx;
      state.y = drag.startY + dy;
      drag.dialog.style.setProperty('translate', `${state.x}px ${state.y}px`);
    },
    { passive: false },
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    document.addEventListener(type, (event) => {
      if (drag && event.pointerId === drag.pointerId) stop();
    });
  document.addEventListener(
    'close',
    (event) => {
      if (event.target.matches?.('dialog')) reset(event.target);
    },
    true,
  );
  window.addEventListener('blur', stop);
  window.addEventListener('resize', () => {
    for (const dialog of moved.keys()) reset(dialog);
  });
  new MutationObserver((entries) => {
    for (const entry of entries) {
      if (entry.type === 'attributes') {
        if (entry.target.open) decorate(entry.target);
        else reset(entry.target);
      } else {
        const dialog = entry.target.closest?.('dialog[open]');
        if (dialog) decorate(dialog);
        for (const node of entry.addedNodes)
          if (node instanceof Element) {
            if (node.matches('dialog[open]')) decorate(node);
            node.querySelectorAll('dialog[open]').forEach(decorate);
          }
      }
    }
    for (const dialog of moved.keys()) if (!dialog.isConnected) reset(dialog);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  document.querySelectorAll('dialog[open]').forEach(decorate);
})();

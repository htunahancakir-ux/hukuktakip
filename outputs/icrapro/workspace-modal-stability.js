// Keeps an open window still: it stays where it opened and never shrinks while the same view
// is shown, so choosing an option that adds or removes fields does not make it jump. A window
// that needs more room grows downward once and then keeps that size.
(() => {
  if (typeof ResizeObserver === 'undefined') return;
  const tracked = new WeakMap();
  const sizes = new ResizeObserver((entries) => entries.forEach((entry) => pin(entry.target)));
  // What is being shown: a different form or title is a different view and is measured anew.
  const view = (dialog) =>
    [
      dialog.firstElementChild?.id || dialog.firstElementChild?.tagName || '',
      dialog.querySelector('h2')?.textContent || '',
      dialog.className.replace(/\bmodal-dragging\b/, '').trim(),
    ].join('|');

  function release(dialog) {
    for (const property of ['min-height', 'margin-top', 'margin-bottom'])
      dialog.style.removeProperty(property);
    tracked.delete(dialog);
  }

  function pin(dialog) {
    if (!dialog.isConnected || !dialog.open) return release(dialog);
    const key = view(dialog);
    let state = tracked.get(dialog);
    if (state && state.key !== key) {
      release(dialog);
      state = null;
    }
    // Full-screen and in-page windows manage their own layout.
    if (!dialog.matches(':modal') || getComputedStyle(dialog).position !== 'fixed') return;
    const height = dialog.getBoundingClientRect().height;
    if (!height) return;
    if (!state) {
      state = { key, height };
      tracked.set(dialog, state);
      // Hold the top edge where it is. offsetTop ignores the drag offset, so a moved window
      // keeps its place; a window positioned some other way keeps its own rules.
      const before = dialog.getBoundingClientRect().top;
      dialog.style.marginTop = dialog.offsetTop - (parseFloat(getComputedStyle(dialog).top) || 0) + 'px';
      dialog.style.marginBottom = 'auto';
      if (Math.abs(dialog.getBoundingClientRect().top - before) > 0.5)
        for (const property of ['margin-top', 'margin-bottom']) dialog.style.removeProperty(property);
    } else if (height <= state.height + 0.5) return;
    state.height = height;
    dialog.style.minHeight = height + 'px';
  }

  function watch(dialog) {
    sizes.observe(dialog);
    pin(dialog);
  }
  const openDialogs = () => document.querySelectorAll('dialog[open]');
  const start = () => {
    new MutationObserver((records) => {
      for (const record of records)
        if (record.type === 'attributes' && record.target.matches?.('dialog')) {
          if (record.target.open) watch(record.target);
          else release(record.target);
        }
      openDialogs().forEach(watch);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'class'],
    });
    openDialogs().forEach(watch);
  };
  document.addEventListener(
    'close',
    (event) => event.target.matches?.('dialog') && release(event.target),
    true,
  );
  window.addEventListener('resize', () => {
    for (const dialog of openDialogs()) {
      release(dialog);
      pin(dialog);
    }
  });
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();

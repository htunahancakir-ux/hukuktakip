(() => {
  const selector =
    'tfoot td, tfoot th, .stat strong, [data-total-label], .detail-field > b, .detail-field > div, p > b, p > strong, .tablefoot b, .tablefoot strong, .notice > b, .notice > strong';
  let active, tooltip;
  const text = (node) => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, [aria-hidden="true"]').forEach((el) => el.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };
  function columnLabel(cell) {
    const table = cell.closest('table');
    if (!table?.tHead) return '';
    const column = [...cell.parentElement.cells].slice(0, cell.cellIndex).reduce((n, c) => n + c.colSpan, 0);
    const grid = [];
    [...table.tHead.rows].forEach((row, r) => {
      grid[r] ||= [];
      let col = 0;
      for (const header of row.cells) {
        while (grid[r][col]) col++;
        for (let y = r; y < r + header.rowSpan; y++) {
          grid[y] ||= [];
          for (let x = col; x < col + header.colSpan; x++) grid[y][x] = header;
        }
        col += header.colSpan;
      }
    });
    const labels = [];
    for (let c = column; c < column + cell.colSpan; c++) {
      const header = grid
        .map((row) => row[c])
        .reverse()
        .find(Boolean);
      if (header) labels.push(text(header));
    }
    return [...new Set(labels.filter(Boolean))].join(' / ');
  }
  function labelFor(target) {
    if (!/\d/.test(target.textContent)) return '';
    if (target.dataset.totalLabel) return target.dataset.totalLabel;
    if (target.closest('tfoot')) return columnLabel(target);
    if (target.matches('.stat strong')) return text(target.closest('.stat').querySelector('small') || target);
    if (target.matches('.detail-field > b, .detail-field > div')) {
      const label = target.parentElement.querySelector('small')?.textContent.trim() || '';
      return /ödenecek|ödenen|kalan|toplam|bakiye|anapara|tahsilat|gider|kâr|tutar|prim|maaş|gelir/i.test(
        label,
      )
        ? label
        : '';
    }
    const range = document.createRange();
    range.setStart(target.parentNode, 0);
    range.setEndBefore(target);
    const prefix = range
      .toString()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[:：·\s]+$/, '');
    return /toplam|bakiye|kalan|tahsilat|ödeme|gider|kâr|net hareket/i.test(prefix) ? prefix.slice(-180) : '';
  }
  function hide() {
    if (tooltip) {
      if (tooltip.matches(':popover-open')) tooltip.hidePopover();
      tooltip.hidden = true;
    }
    if (active) {
      const ids = (active.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((id) => id && id !== 'totalHeadingTooltip');
      if (ids.length) active.setAttribute('aria-describedby', ids.join(' '));
      else active.removeAttribute('aria-describedby');
    }
    active = null;
  }
  function show(target, label) {
    hide();
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'totalHeadingTooltip';
      tooltip.className = 'total-heading-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.setAttribute('popover', 'manual');
      document.body.append(tooltip);
    }
    active = target;
    tooltip.textContent = label;
    tooltip.hidden = false;
    const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add(tooltip.id);
    target.setAttribute('aria-describedby', [...ids].join(' '));
    if (tooltip.showPopover) tooltip.showPopover();
    else (target.closest('dialog') || document.body).append(tooltip);
    const r = target.getBoundingClientRect(),
      t = tooltip.getBoundingClientRect();
    tooltip.style.left =
      Math.max(8, Math.min(r.left + (r.width - t.width) / 2, innerWidth - t.width - 8)) + 'px';
    tooltip.style.top =
      (r.top >= t.height + 12 ? r.top - t.height - 8 : Math.min(r.bottom + 8, innerHeight - t.height - 8)) +
      'px';
  }
  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.(selector);
    if (!target || target === active) return;
    const label = labelFor(target);
    if (label) show(target, label);
  });
  document.addEventListener('pointerout', (event) => {
    if (active?.contains(event.target) && !active.contains(event.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (event) => {
    const target = event.target.closest?.(selector),
      label = target && labelFor(target);
    if (label) show(target, label);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  document.addEventListener('close', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  new MutationObserver(() => {
    if (active && !active.isConnected) hide();
  }).observe(document.body, { childList: true, subtree: true });
})();

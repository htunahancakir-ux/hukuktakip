const listSortCollator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

function listSortButton(tableId, column, label, title = '') {
  return `<button type="button" class="list-sort-button" data-list-sort="${column}" commandfor="${tableId}" command="--sort"${title ? ` title="${title}"` : ''}>${label}<span aria-hidden="true"></span></button>`;
}

function bindListSort(table, state, onSort) {
  const buttons = [...table.querySelectorAll('thead [data-list-sort]')];
  const showDirection = () => {
    for (const button of buttons) {
      const heading = button.closest('th');
      if (button.dataset.listSort === state.column) heading.setAttribute('aria-sort', state.direction);
      else heading.removeAttribute('aria-sort');
    }
  };
  const activate = (button) => {
    const column = button.dataset.listSort;
    state.direction = state.column === column && state.direction === 'ascending' ? 'descending' : 'ascending';
    state.column = column;
    showDirection();
    onSort();
  };
  if ('commandForElement' in HTMLButtonElement.prototype) {
    table.addEventListener('command', (event) => {
      if (event.command === '--sort' && buttons.includes(event.source)) activate(event.source);
    });
  } else {
    for (const button of buttons) button.addEventListener('click', () => activate(button));
  }
  showDirection();
}

function sortLocalListRows(body, records, readValue, direction) {
  const byId = new Map(records.map((record) => [String(record.id), record]));
  const rows = [...body.rows]
    .filter((row) => byId.has(row.dataset.listRecord))
    .map((row) => ({ row, value: readValue(byId.get(row.dataset.listRecord)) }));
  const factor = direction === 'descending' ? -1 : 1;
  rows.sort((a, b) => {
    if (a.value === '' || b.value === '') return Number(a.value === '') - Number(b.value === '');
    const result =
      typeof a.value === 'number' ? a.value - b.value : listSortCollator.compare(a.value, b.value);
    return factor * result;
  });
  const move = body.moveBefore ? (row) => body.moveBefore(row, null) : (row) => body.append(row);
  for (const { row } of rows) move(row);
}

function listSortParam({ column, direction }, defaultSort = '') {
  return column ? column + (direction === 'ascending' ? 'Asc' : 'Desc') : defaultSort;
}

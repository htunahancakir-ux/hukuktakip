// Conflict of interest check for new and renamed parties. While the user types, a hint under
// the name shows whether the party already appears in any file. On save, a match on the other
// side (client against debtor or guarantor) must be acknowledged with a written reason.
(() => {
  const forms = {
    clientForm: { kind: 'client', names: ['fullName', 'tradeName'], label: 'Müvekkil' },
    intakeForm: { kind: 'debtor', names: ['debtor'], label: 'Borçlu' },
    editBorrowerForm: { kind: 'debtor', names: ['debtor'], label: 'Borçlu' },
    guarantorForm: { kind: 'guarantor', names: ['name'], label: 'Kefil' },
  };
  const roles = { client: 'Müvekkil', debtor: 'Borçlu', guarantor: 'Kefil' };
  const timers = new WeakMap(),
    requests = new WeakMap();
  const text = escapeHtml; // html-safety.js
  async function request(path, options, failure) {
    const response = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
      headers: { 'X-Han-Request': '1', ...options?.headers },
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || failure);
    return data;
  }

  function read(form) {
    const config = forms[form.id];
    if (!config) return null;
    const names = config.names.map((name) => String(form.elements[name]?.value || '').trim()).filter(Boolean),
      identity = String(form.elements.identity?.value || '').replace(/\s/g, '');
    return {
      kind: config.kind,
      label: config.label,
      name: names[0] || '',
      name2: names[1] || '',
      identity: /^\d{10,11}$/.test(identity) ? identity : '',
    };
  }
  const key = (input) =>
    input && (input.name || input.identity)
      ? [input.kind, hanPartyName.normalizePartyName(input.name + ' ' + input.name2), input.identity].join(
          '|',
        )
      : '';

  const lookup = (input, signal) =>
    request(
      '/api/conflicts?' +
        new URLSearchParams({
          kind: input.kind,
          name: input.name,
          name2: input.name2,
          identity: input.identity,
        }),
      { signal },
      'Çakışma kontrolü yapılamadı.',
    );

  function itemsMarkup(result) {
    const rows = result.items
      .map(
        (item) =>
          `<tr class="${item.conflict ? 'conflict-row' : ''}"><td><span class="conflict-role conflict-role--${text(item.role)}">${text(roles[item.role] || item.role)}</span></td><td>${text(item.name || '—')}</td><td>${item.identityMatch ? 'TC / vergi no aynı' : item.nameMatch === 'exact' ? 'Ad aynı' : 'Ad benzer'}</td><td>${text(item.number || '—')}${item.archived ? ' <small>arşiv</small>' : ''}</td><td>${text(item.status || '—')}</td><td>${text(item.clientName || '—')}</td></tr>`,
      )
      .join('');
    return (
      (rows
        ? `<div class="overflow"><table class="conflict-table"><thead><tr><th>ROL</th><th>KAYITLI AD</th><th>EŞLEŞME</th><th>DOSYA</th><th>DURUM</th><th>MÜVEKKİL</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '') +
      (result.truncated
        ? '<p class="conflict-hidden">Bu adı içeren kayıt sayısı çok fazla; liste eksik olabilir. Adı tam yazarak veya TC / vergi numarası girerek daraltın.</p>'
        : '') +
      (result.hidden
        ? `<p class="conflict-hidden">${text(result.hidden)} eşleşme, görme yetkiniz olmayan veya arşivdeki kayıtlarda. Ayrıntı için yöneticinize danışın.</p>`
        : '')
    );
  }

  function conflictDialog() {
    let dialog = document.getElementById('conflictDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'conflictDialog';
      document.body.append(dialog);
    }
    return dialog;
  }

  function showMatches(input, result) {
    const dialog = conflictDialog();
    dialog.innerHTML = `<div class="panelhead"><div><h2>Geçmiş Kayıtlarda Eşleşmeler</h2><p>${text(input.label)}: ${text(input.name || input.identity)}</p></div><button type="button" class="secondary" data-conflict-close>Kapat</button></div><div class="formbody">${itemsMarkup(result)}</div>`;
    dialog.querySelector('[data-conflict-close]').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }

  // Resolves true when saving may continue.
  function confirm(input, result) {
    if (!result.conflicts) return Promise.resolve(true);
    return new Promise((resolve) => {
      const dialog = conflictDialog();
      dialog.innerHTML = `<form id="conflictAckForm"><div class="panelhead"><div><h2>Menfaat Çakışması Uyarısı</h2><p>${text(input.label)} olarak kaydettiğiniz taraf, geçmiş kayıtlarda karşı tarafta görünüyor.</p></div></div><div class="formbody"><p class="conflict-lead"><b>${text(input.name || input.identity)}</b> · ${text(result.conflicts)} çakışma${result.infos ? ' · ' + text(result.infos) + ' bilgi amaçlı eşleşme' : ''}</p>${itemsMarkup(result)}<label class="field full">Devam Etme Gerekçesi *<textarea name="reason" required minlength="10" maxlength="500" rows="3" placeholder="Örn. İsim benzerliği; farklı kişi olduğu TC numarasından doğrulandı."></textarea></label><p class="conflict-note">Gerekçeniz, adınız ve tarihle birlikte işlem kayıtlarına yazılır.</p></div><div class="actions"><button type="button" class="secondary" data-conflict-cancel>Kaydı Durdur</button><button class="primary">Gerekçeyle Devam Et</button></div></form>`;
      const form = dialog.querySelector('form');
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        resolve(value);
      };
      dialog.addEventListener('close', () => finish(false), { once: true });
      dialog.querySelector('[data-conflict-cancel]').onclick = () => finish(false);
      form.onsubmit = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = form.querySelector('button.primary');
        if (button.disabled) return;
        button.disabled = true;
        try {
          await request(
            '/api/conflicts/ack',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                kind: input.kind,
                name: input.name || input.identity,
                count: result.conflicts,
                reason: form.elements.reason.value,
              }),
            },
            'Gerekçe kaydedilemedi.',
          );
          finish(true);
        } catch (error) {
          toast(error.message);
          button.disabled = false;
        }
      };
      if (!dialog.open) dialog.showModal();
      form.elements.reason.focus();
    });
  }

  function hintFor(form) {
    const config = forms[form.id],
      anchor = (form.elements[config.names[0]] || form.elements.identity)?.closest('label');
    if (!anchor) return null;
    let hint = form.querySelector('.conflict-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'conflict-hint full';
      hint.setAttribute('role', 'status');
      hint.hidden = true;
      anchor.after(hint);
    }
    return hint;
  }

  async function refreshHint(form) {
    const input = read(form),
      hint = hintFor(form);
    if (!hint) return;
    requests.get(form)?.abort();
    const current = key(input);
    if (!current || current === form.dataset.conflictInitial) {
      hint.hidden = true;
      return;
    }
    const request = new AbortController();
    requests.set(form, request);
    try {
      const result = await lookup(input, request.signal);
      if (request.signal.aborted || !form.isConnected) return;
      const total = result.conflicts + result.infos;
      hint.hidden = !total;
      hint.className =
        'conflict-hint full ' + (result.conflicts ? 'conflict-hint--danger' : 'conflict-hint--info');
      hint.innerHTML = result.conflicts
        ? `<b>Çakışma olabilir:</b> bu taraf ${text(result.conflicts)} kayıtta karşı tarafta görünüyor. <button type="button" class="link">Eşleşmeleri gör</button>`
        : `Bu taraf ${text(result.infos)} kayıtta aynı tarafta kayıtlı. <button type="button" class="link">Eşleşmeleri gör</button>`;
      if (total) hint.querySelector('button').onclick = () => showMatches(input, result);
    } catch (error) {
      if (!request.signal.aborted) hint.hidden = true;
    }
  }

  // The first focus inside a form remembers the party as loaded: an unchanged party is not rechecked.
  document.addEventListener(
    'focusin',
    (event) => {
      const form = event.target.closest?.('form');
      if (form && forms[form.id] && form.dataset.conflictInitial === undefined)
        form.dataset.conflictInitial = key(read(form));
    },
    true,
  );
  document.addEventListener(
    'input',
    (event) => {
      const form = event.target.closest?.('form'),
        config = form && forms[form.id];
      if (!config || ![...config.names, 'identity'].includes(event.target.name)) return;
      if (form.dataset.conflictInitial === undefined) form.dataset.conflictInitial = '';
      clearTimeout(timers.get(form));
      timers.set(
        form,
        setTimeout(() => refreshHint(form), 600),
      );
    },
    true,
  );
  document.addEventListener(
    'submit',
    async (event) => {
      const form = event.target;
      if (!forms[form.id]) return;
      const input = read(form),
        current = key(input);
      if (!current || current === form.dataset.conflictInitial || current === form.dataset.conflictCleared)
        return;
      // Hold this save, check, then submit again once the user has decided.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (form.dataset.conflictBusy) return;
      form.dataset.conflictBusy = '1';
      try {
        const result = await lookup(input);
        if (!form.isConnected) return;
        if (await confirm(input, result)) {
          form.dataset.conflictCleared = current;
          form.requestSubmit(event.submitter || undefined);
        }
      } catch (error) {
        toast('Çakışma kontrolü yapılamadı, kayıt bekletildi: ' + error.message);
      } finally {
        delete form.dataset.conflictBusy;
      }
    },
    true,
  );
  window.hanConflicts = { lookup, confirm };
})();

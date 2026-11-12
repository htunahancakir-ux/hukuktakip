// Remote support access, office side: one strip above the page while the platform's support team
// may be (or is) inside the office, and while a support answer waits for the person who opened the
// ticket. The server decides everything (GET /api/support-access/status); this file only shows it,
// counts the remaining time down locally between polls and sends the office's decisions. Every
// server-supplied text is put on the page with textContent, never as HTML.
const SUPPORT_ACCESS_FAST_MS = 30000; // something to watch: an open grant or an answered ticket
const SUPPORT_ACCESS_SLOW_MS = 300000; // nothing to watch
const SUPPORT_ACCESS_ZERO_REPOLL_MS = 4000;

const supportAccessState = {
  started: false,
  status: { access: null, self: null, answered: [] },
  syncedAt: 0,
  lastPollAt: 0,
  signature: '',
  flight: null,
  pollTimer: null,
  tickTimer: null,
  hadSelf: false,
  reloading: false,
};

// Replaceable in tests.
function supportAccessNow() {
  return Date.now();
}
function supportAccessReload() {
  location.reload();
}

// 125 -> "02:05"; the largest grant is 60 minutes, so minutes are never rolled into hours.
function supportAccessClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function supportAccessRemaining(view) {
  if (!view || !Number.isFinite(Number(view.remainingSeconds))) return null;
  const elapsed = (supportAccessNow() - supportAccessState.syncedAt) / 1000;
  return Math.max(0, Math.ceil(Number(view.remainingSeconds) - elapsed));
}

function supportAccessIsSupportUser() {
  return window.hanAuth?.platformSupport === true;
}

// Read-only accounts cannot write; the server refuses them, so the buttons are not offered.
function supportAccessCanAct() {
  return !!window.hanAuth && !(window.hanAuth.readOnly && window.hanAuth.role !== 'ceo');
}

// What decides whether the strip must be rebuilt (the clock is excluded: it ticks by itself).
function supportAccessSignature(status) {
  const part = (view) =>
    view
      ? [
          view.id,
          view.ticketId,
          view.state,
          view.minutes,
          view.allowEdit,
          view.canDecide,
          view.extensionRequest?.minutes,
          view.extensionRequest?.note,
        ]
      : null;
  const first = status.answered[0];
  return JSON.stringify([
    part(status.access),
    part(status.self),
    first ? [first.ticketId, first.number, first.subject, first.reply] : null,
    supportAccessCanAct(),
  ]);
}

function supportAccessNormalize(raw) {
  return {
    access: raw && typeof raw.access === 'object' ? raw.access : null,
    self: raw && typeof raw.self === 'object' ? raw.self : null,
    answered: Array.isArray(raw?.answered) ? raw.answered : [],
  };
}

function supportAccessHasWork(status = supportAccessState.status) {
  return !!(status.access || status.self || status.answered.length);
}

function supportAccessSchedule() {
  clearTimeout(supportAccessState.pollTimer);
  if (!supportAccessState.started) return;
  supportAccessState.pollTimer = setTimeout(
    pollSupportAccess,
    supportAccessHasWork() ? SUPPORT_ACCESS_FAST_MS : SUPPORT_ACCESS_SLOW_MS,
  );
}

// One status request. Never throws and never rejects: a failed attempt is retried on the next
// round. Resolves to true when a status was received.
function pollSupportAccess() {
  if (supportAccessState.flight) return supportAccessState.flight;
  clearTimeout(supportAccessState.pollTimer);
  if (!window.hanAuth || document.hidden) return Promise.resolve(false);
  supportAccessState.lastPollAt = supportAccessNow();
  const flight = (async () => {
    try {
      const response = await fetch('/api/support-access/status', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Han-Request': '1' },
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
      });
      if (response.status === 401 && supportAccessIsSupportUser()) {
        // The support session ends at its deadline: back to the sign-in screen.
        supportAccessEnded();
      } else if (response.ok) {
        applySupportAccessStatus(await response.json());
        return true;
      }
    } catch {
      // Silent: the next round tries again.
    }
    return false;
  })();
  supportAccessState.flight = flight;
  flight.then(() => {
    if (supportAccessState.flight === flight) supportAccessState.flight = null;
    supportAccessSchedule();
  });
  return flight;
}

// Used after something changed (a decision on the strip, a grant on the ticket) so the strip
// follows at once, even when a poll is already on its way.
function refreshSupportAccess() {
  const current = supportAccessState.flight;
  return current ? current.then(pollSupportAccess) : pollSupportAccess();
}

function supportAccessEnded() {
  if (supportAccessState.reloading) return;
  supportAccessState.reloading = true;
  supportAccessReload();
}

function applySupportAccessStatus(raw) {
  const status = supportAccessNormalize(raw);
  supportAccessState.status = status;
  supportAccessState.syncedAt = supportAccessNow();
  if (supportAccessIsSupportUser()) {
    const self = status.self;
    const over =
      !self || !['pending', 'connected'].includes(self.state) || supportAccessRemaining(self) === 0;
    if (supportAccessState.hadSelf && over) return supportAccessEnded();
    supportAccessState.hadSelf = !!self && !over;
  }
  const signature = supportAccessSignature(status);
  if (signature !== supportAccessState.signature) {
    supportAccessState.signature = signature;
    renderSupportAccessStrip();
  }
  tickSupportAccess();
}

function supportAccessHost() {
  let strip = document.getElementById('supportAccessStrip');
  if (strip) return strip;
  strip = document.createElement('div');
  strip.id = 'supportAccessStrip';
  strip.className = 'support-strip';
  strip.setAttribute('role', 'region');
  strip.setAttribute('aria-label', 'Destek erişimi');
  strip.hidden = true;
  const shell = document.querySelector('.shell');
  if (shell) shell.prepend(strip);
  else document.body.prepend(strip);
  return strip;
}

// One line of the strip: plain text with an optional live clock, then buttons.
function supportStripRow(kind, parts, buttons = []) {
  const row = document.createElement('div');
  row.className = `support-strip-row support-strip-${kind}`;
  const text = document.createElement('span');
  text.className = 'support-strip-text';
  for (const part of parts) {
    if (typeof part === 'string') text.append(document.createTextNode(part));
    else {
      const clock = document.createElement('b');
      clock.className = 'support-strip-clock';
      clock.dataset.supportClock = part.clock;
      clock.textContent = supportAccessClock(supportAccessRemaining(part.view));
      text.append(clock);
    }
  }
  if (!parts.some((part) => typeof part !== 'string')) row.setAttribute('role', 'status');
  row.append(text);
  for (const { label, className, onClick } of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `support-strip-button ${className || ''}`.trim();
    button.textContent = label;
    button.onclick = onClick;
    row.append(button);
  }
  return row;
}

function supportAccessAct(task, success) {
  try {
    task();
    if (success) toast(success);
  } catch (error) {
    toast(error.message || 'İşlem yapılamadı.');
  }
  return refreshSupportAccess();
}

function supportAccessEndButton(access, label) {
  return {
    label,
    className: 'support-strip-danger',
    onClick: () => {
      if (!window.confirm('Destek ekibinin büronuza erişimi şimdi sonlandırılsın mı?')) return;
      supportAccessAct(
        () => authApi('/api/support-access/' + encodeURIComponent(access.id) + '/end', 'POST', {}),
        'Destek erişimi sonlandırıldı.',
      );
    },
  };
}

function supportAccessRows(status) {
  const rows = [];
  const act = supportAccessCanAct();
  const self = supportAccessIsSupportUser() ? status.self : null;
  if (self) {
    rows.push(
      supportStripRow('self', [
        'Hukuk Takip Platformu destek oturumu',
        ...(Number.isFinite(Number(self.remainingSeconds))
          ? [' · kalan ', { clock: 'self', view: self }]
          : []),
        ` · ${self.allowEdit ? 'Düzenleme açık' : 'Salt okunur'}`,
      ]),
    );
  }
  const access = supportAccessIsSupportUser() ? null : status.access;
  if (access) {
    const decide = act && access.canDecide === true;
    if (access.state === 'pending') {
      rows.push(
        supportStripRow(
          'pending',
          [`Destek ekibine ${access.minutes} dk erişim izni verildi · bağlantı bekleniyor`],
          decide ? [supportAccessEndButton(access, 'İzni geri al')] : [],
        ),
      );
    } else if (access.state === 'connected') {
      rows.push(
        supportStripRow(
          'connected',
          [
            'Destek ekibi şu an bağlı · kalan ',
            { clock: 'access', view: access },
            ` · ${access.allowEdit ? 'Değişiklik yapabilir' : 'Yalnızca görüntüleme'}`,
          ],
          decide ? [supportAccessEndButton(access, 'Erişimi sonlandır')] : [],
        ),
      );
    } else if (access.state === 'overtime') {
      rows.push(
        supportStripRow(
          'overtime',
          ['Destek ekibinin süresi doldu.'],
          decide ? [supportAccessEndButton(access, 'Erişimi sonlandır')] : [],
        ),
      );
    }
    const request = access.extensionRequest;
    if (request) {
      const decideExtension = (approve) => () =>
        supportAccessAct(
          () =>
            authApi('/api/support-access/' + encodeURIComponent(access.id) + '/extension', 'POST', {
              approve,
            }),
          approve ? 'Ek süre onaylandı.' : 'Ek süre talebi reddedildi.',
        );
      rows.push(
        supportStripRow(
          'extension',
          [`Destek ekibi ${request.minutes} dk ek süre istiyor${request.note ? ': ' + request.note : ''}`],
          decide
            ? [
                { label: 'Onayla', className: 'support-strip-primary', onClick: decideExtension(true) },
                { label: 'Reddet', onClick: decideExtension(false) },
              ]
            : [],
        ),
      );
    }
  }
  const answered = supportAccessIsSupportUser() ? null : status.answered[0];
  if (answered) {
    const ticket = encodeURIComponent(answered.ticketId);
    rows.push(
      supportStripRow(
        'answered',
        [`Destek yanıt verdi (#${answered.number} ${answered.subject}): ${answered.reply}`],
        [
          ...(act
            ? [
                {
                  label: 'Çözüldü',
                  className: 'support-strip-primary',
                  onClick: () =>
                    supportAccessAct(
                      () => authApi('/api/support/' + ticket + '/resolved', 'POST', {}),
                      'Teşekkürler, kayıt çözüldü olarak işaretlendi.',
                    ),
                },
                {
                  label: 'Hâlâ sorun var',
                  onClick: () =>
                    supportAccessAct(
                      () =>
                        authApi('/api/support/' + ticket + '/messages', 'POST', {
                          body: 'Sorun devam ediyor.',
                        }),
                      'Destek ekibine sorunun sürdüğü bildirildi.',
                    ),
                },
              ]
            : []),
          ...(typeof supportTicketDialog === 'function'
            ? [{ label: 'Kaydı aç', onClick: () => supportTicketDialog(answered.ticketId) }]
            : []),
        ],
      ),
    );
  }
  return rows;
}

function renderSupportAccessStrip() {
  const rows = supportAccessRows(supportAccessState.status);
  const strip = supportAccessHost();
  strip.replaceChildren(...rows);
  strip.hidden = rows.length === 0;
  document.body.classList.toggle('has-support-strip', rows.length > 0);
  supportAccessMeasure();
}

// The sticky page header sits right below the strip.
function supportAccessMeasure() {
  const strip = document.getElementById('supportAccessStrip');
  const height = strip && !strip.hidden ? strip.offsetHeight : 0;
  document.documentElement.style.setProperty('--support-strip-h', height + 'px');
}

// Once a second: move the clocks; when a tracked clock has run out, ask the server what is true now.
function tickSupportAccess() {
  const strip = document.getElementById('supportAccessStrip');
  if (strip && !strip.hidden)
    for (const clock of strip.querySelectorAll('[data-support-clock]')) {
      const view =
        clock.dataset.supportClock === 'self'
          ? supportAccessState.status.self
          : supportAccessState.status.access;
      clock.textContent = supportAccessClock(supportAccessRemaining(view));
    }
  const tracked = supportAccessIsSupportUser()
    ? supportAccessState.status.self
    : supportAccessState.status.access?.state === 'connected'
      ? supportAccessState.status.access
      : null;
  if (
    tracked &&
    supportAccessRemaining(tracked) === 0 &&
    supportAccessNow() - supportAccessState.lastPollAt >= SUPPORT_ACCESS_ZERO_REPOLL_MS
  )
    pollSupportAccess();
}

function startSupportAccess() {
  if (supportAccessState.started) return;
  if (globalThis.hanModules?.['supportDesk'] !== true || !window.hanAuth) return;
  supportAccessState.started = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollSupportAccess();
  });
  window.addEventListener('resize', supportAccessMeasure);
  supportAccessState.tickTimer = setInterval(tickSupportAccess, 1000);
  pollSupportAccess();
}

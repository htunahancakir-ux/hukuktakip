window.hanAuth = null;
const protectedKeys = new Set([
  'icrapro-v1',
  'icrapro-personnel-v1',
  'icrapro-settings-v1',
  'hanhukuk-finance-v1',
  'hanhukuk-accounting-v1',
  'icrapro-cases-v1',
]);
const hanDataVersions = new Map();
function authApi(url, method = 'GET', data) {
  const request = new XMLHttpRequest();
  request.open(method, url, false);
  request.setRequestHeader('X-Han-Request', '1');
  if (method === 'PUT' && url.startsWith('/api/data?') && hanDataVersions.has(url))
    request.setRequestHeader('If-Match', hanDataVersions.get(url));
  if (data !== undefined) request.setRequestHeader('Content-Type', 'application/json');
  request.send(data === undefined ? null : JSON.stringify(data));
  let result;
  try {
    result = JSON.parse(request.responseText);
  } catch {
    throw Error('Sunucuya ulaşılamadı.');
  }
  if (request.status === 401 && hanAuth) {
    location.reload();
    throw Error('Oturum sona erdi. Yeniden giriş yapın.');
  }
  if (request.status === 428 && result.code === 'employee_terms_required') {
    location.reload();
    throw Error(result.error);
  }
  if (request.status < 200 || request.status >= 300) throw Error(result.error || 'İşlem yapılamadı.');
  const version = request.getResponseHeader('ETag');
  if (version && url.startsWith('/api/data?')) hanDataVersions.set(url, version);
  return result;
}
function hanCan(permission) {
  return (
    !!hanAuth &&
    (['ceo', 'admin'].includes(hanAuth.role) ||
      permission === 'documents' ||
      hanAuth.permissions.includes(permission))
  );
}
function hanPageAllowed(p) {
  return (
    ['ceo', 'admin'].includes(hanAuth?.role) ||
    (!!hanAuth && ['home', 'messages', 'reports', 'reminders'].includes(p)) ||
    (p === 'accounting' && (hanCan('cashIn') || hanCan('cashOut'))) ||
    (p === 'clients' && hanCan('clients')) ||
    (['intake', 'documents'].includes(p) && hanCan('documents'))
  );
}
function staffHome() {
  return 'home';
}
function accessMenu() {
  document
    .querySelectorAll('nav [data-page]')
    .forEach((button) => (button.hidden = !hanPageAllowed(button.dataset.page)));
  let nav = document.querySelector('nav');
  if (['ceo', 'admin'].includes(hanAuth.role) && !document.getElementById('usersNavigation')) {
    const button = document.createElement('button');
    button.id = 'usersNavigation';
    button.textContent = '⚿ Kullanıcı Yönetimi';
    button.onclick = () => {
      page = 'users';
      render();
    };
    nav.append(button);
  }
  const op = document.getElementById('activeOperator');
  if (op) {
    op.outerHTML =
      '<button type="button" class="link" id="signedInUser" title="Hesabım · Sözleşme geçmişi"></button>';
    const account = document.getElementById('signedInUser');
    account.textContent = hanAuth.name + (hanAuth.role === 'ceo' ? ' · CEO' : '') + ' · Hesabım';
    account.setAttribute('aria-label', 'Hesabım · ' + hanAuth.name);
    account.onclick = showMyEmployeeTerms;
  }
  if (!document.getElementById('signOut')) {
    const b = document.createElement('button');
    b.id = 'signOut';
    b.className = 'secondary';
    b.textContent = 'Çıkış';
    b.onclick = () => {
      authApi('/api/logout', 'POST', {});
      location.reload();
    };
    document.querySelector('header').append(b);
  }
}
function installServerStorage() {
  const get = Storage.prototype.getItem,
    set = Storage.prototype.setItem;
  Storage.prototype.getItem = function (key) {
    if (this === localStorage && protectedKeys.has(key))
      return JSON.stringify(authApi('/api/data?key=' + encodeURIComponent(key)));
    return get.call(this, key);
  };
  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage && protectedKeys.has(key)) {
      authApi('/api/data?key=' + encodeURIComponent(key), 'PUT', { value: JSON.parse(value) });
      return;
    }
    return set.call(this, key, value);
  };
}
async function launchApplication() {
  for (const key of protectedKeys) localStorage.removeItem(key);
  installServerStorage();
  for (const file of workspaceScripts)
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = file;
      script.onload = resolve;
      script.onerror = reject;
      document.body.append(script);
    });
  document.getElementById('authGate')?.remove();
  document.querySelector('aside').hidden = false;
  document.querySelector('.shell').hidden = false;
  accessMenu();
  if (embeddedIntake) return;
  setupWorkspaceSearch();
  startMessageNotifications();
  startCollectionNotices();
  startWorkflowNotices();
  startScheduledReminderNotices();
  showPendingWorkOrders();
}
function installPasswordVisibility(form) {
  form.querySelectorAll('input[type="password"]').forEach((input, index) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'password-input-wrap';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);
    input.id = input.id || 'login-password-' + index;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-visibility';
    button.setAttribute('aria-controls', input.id);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Şifreyi göster');
    button.title = 'Şifreyi göster';
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="password-eye-slash" d="M3 3l18 18"/></svg>';
    button.onclick = () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? 'Şifreyi gizle' : 'Şifreyi göster');
      button.title = visible ? 'Şifreyi gizle' : 'Şifreyi göster';
    };
    wrapper.append(button);
  });
}
function authGate(setup) {
  document.querySelector('aside').hidden = true;
  document.querySelector('.shell').hidden = true;
  let gate = document.getElementById('authGate');
  if (!gate) {
    gate = document.createElement('main');
    gate.id = 'authGate';
    document.body.append(gate);
  }
  gate.innerHTML = `<form id="loginForm" class="panel"><div class="panelhead"><div><h2>Han Hukuk Takip</h2><p>${setup ? 'İlk Yönetici Hesabını Oluştur' : 'Kullanıcı Girişi'}</p></div></div><div class="formbody grid">${setup ? '<label class="field full">Yönetici Ad Soyad<input name="name" required autocomplete="name"></label>' : ''}<label class="field full">Kullanıcı Adı<input name="username" required autocomplete="username"></label><label class="field full">Şifre<input name="password" type="password" required ${setup ? 'minlength="10"' : ''} autocomplete="${setup ? 'new-password' : 'current-password'}"></label>${setup ? '<label class="field full">Şifre Tekrar<input name="confirm" type="password" required minlength="10" autocomplete="new-password"></label><p class="full">Şifre en az 10 karakter olmalıdır. Bu tarayıcıdaki mevcut kayıtlar yönetici kurulumunda sunucuya taşınır. Şifrenizi unutmayın.</p>' : ''}<p id="authError" class="full" role="alert"></p></div><div class="actions"><button class="primary">${setup ? 'Yönetici Hesabını Oluştur' : 'Giriş Yap'}</button></div></form>`;
  const loginForm = document.getElementById('loginForm');
  loginForm.insertAdjacentHTML('afterbegin', loginBrand());
  const submit = loginForm.querySelector('.actions button');
  submit.type = 'submit';
  if (!setup) {
    const forgot = document.createElement('button');
    forgot.type = 'button';
    forgot.className = 'link';
    forgot.textContent = 'Şifremi Unuttum';
    forgot.onclick = () => passwordRecoveryGate();
    submit.before(forgot);
  }
  installPasswordVisibility(loginForm);
  loginForm.onsubmit = async (event) => {
    event.preventDefault();
    const button = submit;
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.target));
      if (setup) {
        if (data.password !== data.confirm) throw Error('Şifreler aynı olmalıdır.');
        data.legacy = {};
        for (const key of protectedKeys) {
          const value = localStorage.getItem(key);
          if (value !== null)
            try {
              data.legacy[key] = JSON.parse(value);
            } catch {}
        }
      }
      hanAuth = authApi(setup ? '/api/setup' : '/api/login', 'POST', data);
      await enterWorkspace();
    } catch (error) {
      const output = document.getElementById('authError');
      if (output) output.textContent = error.message || 'Uygulama yüklenemedi.';
      button.disabled = false;
    }
  };
}

const passwordLink = /^#sifre=([a-zA-Z0-9_-]{43})$/.exec(location.hash);
if (passwordLink) {
  history.replaceState(null, '', location.pathname + location.search);
  passwordRecoveryGate(passwordLink[1]);
} else {
  try {
    const session = authApi('/api/session');
    if (session.appVersion) {
      document.getElementById('appVersion').textContent = '●  Sürüm ' + session.appVersion;
    }
    if (session.user) {
      hanAuth = session.user;
      enterWorkspace().catch(() => {
        authGate(false);
        document.getElementById('authError').textContent = 'Çalışma alanı açılamadı. Sayfayı yenileyin.';
      });
    } else authGate(session.setup);
  } catch {
    authGate(false);
    document.getElementById('authError').textContent = 'Sunucuya ulaşılamadı. Uygulamayı yeniden başlatın.';
  }
}

let messageBox = 'inbox',
  messageOffset = 0,
  messageNoticeTimer,
  messageKnownUnread = null;

let communicationView = 'messages',
  workOrderScope = 'mine',
  workOrderStatus = 'pending',
  workOrderOffset = 0;

let collectionNoticeTimer,
  collectionNoticeCursor = null,
  collectionNoticeBusy = false,
  collectionNoticeQueue = [],
  collectionNoticeShowing = false;

let paymentPromiseDay = '';
setInterval(() => {
  if (!hanAuth || typeof page === 'undefined') return;
  const day = businessDate();
  if (page === 'home' && day !== paymentPromiseDay) {
    paymentPromiseDay = day;
    loadPaymentPromisesHome();
  }
}, 60000);

let workflowNoticeTimer,
  workflowNoticeBusy = false;
const queuedWorkflowNotices = new Set();

let callReminderStaffFilter = '';

setInterval(() => {
  if (
    typeof hanAuth !== 'undefined' &&
    hanAuth &&
    typeof page !== 'undefined' &&
    page === 'home' &&
    !document.querySelector('dialog[open]')
  )
    loadCallRemindersHome();
}, 15000);

setInterval(() => {
  if (
    typeof hanAuth !== 'undefined' &&
    hanAuth &&
    typeof page !== 'undefined' &&
    page === 'home' &&
    !document.querySelector('dialog[open]')
  )
    loadDueInstallmentsHome();
}, 30000);

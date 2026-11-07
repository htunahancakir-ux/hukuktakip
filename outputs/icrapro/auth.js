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

const headerNotificationState = { unread: 0, pendingWorkOrders: 0, dueReminders: 0 };

function updateHeaderNotifications(next = {}) {
  Object.assign(headerNotificationState, next);
  const bell = document.getElementById('notificationBell');
  const count = document.getElementById('notificationCount');
  if (!bell || !count) return;
  const total = Object.values(headerNotificationState).reduce((sum, value) => sum + Number(value || 0), 0);
  count.textContent = total > 99 ? '99+' : total;
  count.hidden = total < 1;
  bell.classList.toggle('has-notifications', total > 0);
  bell.title = total
    ? `${headerNotificationState.unread} okunmamış mesaj, ${headerNotificationState.pendingWorkOrders} bekleyen iş emri, ${headerNotificationState.dueReminders} zamanı gelen hatırlatma`
    : 'Bildirim yok';
}

function accountRoleLabel(role) {
  return role === 'ceo' ? 'CEO' : role === 'admin' ? 'Yönetici' : 'Personel';
}

function accountInitials(name) {
  return String(name || 'H')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toLocaleUpperCase('tr');
}

function showAccountPanel() {
  const modal = document.getElementById('modal');
  const user = hanAuth;
  modal.innerHTML = `<form id="accountSettingsForm" aria-labelledby="accountSettingsTitle">
    <div class="panelhead"><div><h2 id="accountSettingsTitle">Hesabım</h2><p>${esc(user.name)} · ${accountRoleLabel(user.role)}</p></div><button type="button" class="secondary" id="closeAccountSettings">Kapat</button></div>
    <div class="formbody account-settings-form">
      <div class="account-identity"><span>${esc(accountInitials(user.name))}</span><div><strong>${esc(user.name)}</strong><small>${esc(user.username)} · ${accountRoleLabel(user.role)}</small></div></div>
      <section><h3>Şifre değiştir</h3><p class="account-help">Güvenliğiniz için önce mevcut şifrenizi doğrulayın. Şifre değiştiğinde diğer açık oturumlar kapatılır.</p>
        <label class="field">Mevcut şifre<input name="currentPassword" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label>
        <label class="field">Yeni şifre<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>
        <label class="field">Yeni şifre tekrar<input name="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="128" required></label>
        <p id="accountPasswordStatus" class="account-password-status" role="status"></p>
      </section>
    </div>
    <div class="actions"><button type="button" class="secondary" id="openAccountTerms">Sözleşme geçmişim</button><span><button type="button" class="secondary" id="cancelAccountSettings">Vazgeç</button><button type="submit" class="primary">Şifreyi değiştir</button></span></div>
  </form>`;
  const form = document.getElementById('accountSettingsForm');
  installPasswordVisibility(form);
  const close = () => modal.close();
  document.getElementById('closeAccountSettings').onclick = close;
  document.getElementById('cancelAccountSettings').onclick = close;
  document.getElementById('openAccountTerms').onclick = () => {
    modal.close();
    showMyEmployeeTerms();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const status = document.getElementById('accountPasswordStatus');
    if (values.password !== values.confirmPassword) {
      status.textContent = 'Yeni şifreler aynı olmalıdır.';
      return;
    }
    try {
      authApi('/api/account/password', 'POST', values);
      form.reset();
      window.modalFormSaved?.(form);
      status.textContent = 'Şifreniz değiştirildi. Diğer açık oturumlar kapatıldı.';
      toast('Şifreniz güncellendi.');
    } catch (error) {
      status.textContent = error.message;
    }
  };
  modal.showModal();
}

function openHeaderNotifications() {
  if (typeof page === 'undefined') return;
  page = headerNotificationState.dueReminders ? 'reminders' : 'messages';
  render();
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
  const slot = document.getElementById('accountSlot');
  if (slot) {
    slot.innerHTML = `<button type="button" class="account-menu-trigger" id="signedInUser" aria-haspopup="dialog" title="Hesabım">
      <span class="account-menu-avatar">${esc(accountInitials(hanAuth.name))}</span><span class="account-menu-copy"><small>${accountRoleLabel(hanAuth.role)}</small><strong>${esc(hanAuth.name)}</strong></span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>`;
    document.getElementById('signedInUser').onclick = showAccountPanel;
  }
  const bell = document.getElementById('notificationBell');
  if (bell) bell.onclick = openHeaderNotifications;
  const signOut = document.getElementById('signOut');
  if (signOut)
    signOut.onclick = () => {
      authApi('/api/logout', 'POST', {});
      location.reload();
    };
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
  refreshBackupIndicator();
  startPresenceHeartbeat();
  if (embeddedIntake) return;
  setupWorkspaceSearch();
  startMessageNotifications();
  startCollectionNotices();
  startWorkflowNotices();
  startScheduledReminderNotices();
  showPendingWorkOrders();
}

async function presenceRequest(method) {
  const response = await fetch('/api/presence', {
    method,
    headers: { 'X-Han-Request': '1' },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || 'Aktif kullanıcı bilgisi alınamadı.');
  return result;
}

async function refreshOnlineUsersButton() {
  const button = document.getElementById('onlineUsersButton');
  if (!button || hanAuth?.role !== 'ceo') return;
  try {
    const { active, windowMinutes } = await presenceRequest('GET');
    document.getElementById('onlineUserCount').textContent = active.length;
    button.title = `Son ${windowMinutes} dakika içinde etkin olan kullanıcılar`;
    button.hidden = false;
  } catch {
    button.hidden = true;
  }
}

async function showOnlineUsers() {
  try {
    const { active, windowMinutes } = await presenceRequest('GET');
    const modal = document.getElementById('modal');
    modal.innerHTML = `<div class="panelhead"><div><h2>Aktif kullanıcılar</h2><p>Son ${windowMinutes} dakika içinde etkin olan hesaplar.</p></div><button type="button" class="secondary" id="closeOnlineUsers">Kapat</button></div><div class="formbody"><p><b>${active.length}</b> aktif kullanıcı</p>${
      active.length
        ? `<div class="online-users-list">${active
            .map(
              (user) =>
                `<div><b>${esc(user.name)}</b><small>${user.role === 'ceo' ? 'CEO' : user.role === 'admin' ? 'Yönetici' : 'Personel'} · Son etkinlik: ${new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', timeStyle: 'short' }).format(new Date(user.lastSeenAt))}</small></div>`,
            )
            .join('')}</div>`
        : '<p>Şu anda etkin kullanıcı görünmüyor.</p>'
    }</div><div class="actions"><button type="button" class="secondary" id="refreshOnlineUsers">Yenile</button></div>`;
    document.getElementById('closeOnlineUsers').onclick = () => modal.close();
    document.getElementById('refreshOnlineUsers').onclick = showOnlineUsers;
    if (!modal.open) modal.showModal();
  } catch (error) {
    toast(error.message);
  }
}

function startPresenceHeartbeat() {
  const button = document.getElementById('onlineUsersButton');
  if (hanAuth?.role === 'ceo' && button) button.onclick = showOnlineUsers;
  const heartbeat = () => {
    if (document.visibilityState === 'visible') presenceRequest('POST').catch(() => {});
    refreshOnlineUsersButton();
  };
  heartbeat();
  setInterval(heartbeat, 60000);
  document.addEventListener('visibilitychange', heartbeat);
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
  loginFrame(`<form id="loginForm" class="panel" aria-labelledby="loginTitle">
    <div class="login-heading"><h1 id="loginTitle">${setup ? 'İlk adımı atın.' : 'Hoş geldiniz.'}</h1>
      <p>${setup ? 'Han Hukuk çalışma alanınız için ilk yönetici hesabını oluşturun.' : 'Çalışma alanınıza erişmek için<br>hesap bilgilerinizle giriş yapın.'}</p></div>
    <div class="login-fields">
      ${setup ? '<label class="field" for="login-name">Ad soyad<input id="login-name" name="name" required autocomplete="name" placeholder="Adınız ve soyadınız"></label>' : ''}
      <label class="field" for="login-username">Kullanıcı adı
        <span class="login-control">${loginIcon('user')}<input id="login-username" name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Kullanıcı adınızı girin" aria-describedby="authError"></span>
      </label>
      <div class="field"><div class="login-field-label"><label for="login-password">Şifre</label>
        ${setup ? '' : '<button type="button" class="login-link" id="forgotPassword">Şifremi unuttum</button>'}</div>
        <div class="login-control">${loginIcon('lock')}<input id="login-password" name="password" type="password" required ${setup ? 'minlength="10"' : ''} autocomplete="${setup ? 'new-password' : 'off'}" placeholder="Şifrenizi girin" aria-describedby="authError"></div>
      </div>
      ${setup ? '' : '<label class="login-remember"><input id="rememberLogin" name="remember" type="checkbox" autocomplete="off"><span><strong>Beni hatırla</strong><small>Bu seçeneği yalnızca kişisel ve güvenilir cihazlarda kullanın.</small></span></label>'}
      ${setup ? '<label class="field" for="login-confirm">Şifre tekrar<input id="login-confirm" name="confirm" type="password" required minlength="10" autocomplete="new-password" placeholder="Şifrenizi tekrar girin"></label><p class="login-note">Şifreniz en az 10 karakter olmalı. Bu tarayıcıdaki mevcut kayıtlar yönetici kurulumunda sunucuya taşınır.</p>' : ''}
    </div>
    <p id="authError" class="login-status" role="alert"></p>
    <div class="login-actions"><button class="login-submit" type="submit">${setup ? 'Yönetici hesabını oluştur' : 'Giriş yap'}</button></div>
    <div class="login-authorized">${loginIcon('lock')}<span>Yalnızca yetkili kullanıcılar içindir.</span></div>
  </form>`);
  const loginForm = document.getElementById('loginForm');
  const submit = loginForm.querySelector('[type="submit"]');
  if (!setup) {
    document.getElementById('forgotPassword').onclick = () => {
      passwordRecoveryGate();
      document.getElementById('recovery-account').focus({ preventScroll: true });
    };
    const remember = document.getElementById('rememberLogin');
    const password = document.getElementById('login-password');
    const syncPasswordAutocomplete = () => {
      password.autocomplete = remember.checked ? 'current-password' : 'off';
    };
    remember.onchange = syncPasswordAutocomplete;
    syncPasswordAutocomplete();
    // Browsers may ignore autocomplete="off" on sign-in forms. Until the user
    // explicitly opts in, clear any password manager fill that occurs on render.
    const clearUnselectedAutofill = () => {
      if (!remember.checked) password.value = '';
    };
    clearUnselectedAutofill();
    requestAnimationFrame(() => requestAnimationFrame(clearUnselectedAutofill));
    setTimeout(clearUnselectedAutofill, 150);
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

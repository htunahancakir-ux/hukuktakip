function loginBrandMark() {
  return `<img src="${assetUrl('brand-scales.png')}" width="43" height="43" alt="" aria-hidden="true">`;
}

function loginBrand() {
  return `<div class="login-brand"><a class="brand brand-home" href="/" aria-label="HAN (PATAN) HUKUK · Ana Sayfa"><span class="login-brand-mark">${loginBrandMark()}</span><strong>HAN (PATAN)<span> HUKUK</span></strong></a><small>HUKUK VE TAHSİLAT YÖNETİMİ</small></div>`;
}

function loginIcon(kind) {
  const drawing =
    kind === 'user'
      ? '<circle cx="12" cy="8" r="3.25"/><path d="M5.5 20v-2a6.5 6.5 0 0 1 13 0v2"/>'
      : '<rect x="5" y="10" width="14" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/>';
  return `<svg class="login-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${drawing}</svg>`;
}

// The texts on the login picture. An office can place its own in Ayarlar → Firma Bilgileri →
// "Yazıları Düzenle"; these are the built-in ones, the same as the fixed markup below. x and y
// are the text's top left corner in percent of the picture panel, size is percent of the
// panel's width (CSS cqw), so a 1440 × 900 screen and the settings preview look alike.
const LOGIN_TEXT_DEFAULTS = [
  {
    id: 'marka',
    text: 'HAN (PATAN) HUKUK',
    style: 'brand',
    color: 'white',
    bold: true,
    x: 15,
    y: 6.4,
    size: 4,
  },
  {
    id: 'alt-baslik',
    text: 'HUKUK VE TAHSİLAT YÖNETİMİ',
    style: 'label',
    color: 'soft',
    bold: false,
    x: 15,
    y: 12.6,
    size: 1.12,
  },
  {
    id: 'baslik',
    text: 'Her dosyada özen.',
    style: 'heading',
    color: 'white',
    bold: false,
    x: 15,
    y: 81.5,
    size: 5.7,
  },
  {
    id: 'aciklama',
    text: 'Hukuk ve tahsilat yönetiminiz, tek bir çalışma alanında.',
    style: 'text',
    color: 'soft',
    bold: false,
    x: 15,
    y: 89.3,
    size: 1.6,
  },
  {
    id: 'alan-adi',
    text: 'hanhukuktakip.com',
    style: 'text',
    color: 'gold',
    bold: true,
    x: 15,
    y: 93.8,
    size: 1.5,
  },
];

// Position, size and style classes; other classes on the element (the editor's) are kept.
function placeLoginText(el, item) {
  for (const name of [...el.classList]) if (name.startsWith('login-text')) el.classList.remove(name);
  el.classList.add('login-text', `login-text--${item.style}`, `login-text--${item.color}`);
  if (item.bold) el.classList.add('login-text--bold');
  el.style.left = item.x + '%';
  el.style.top = item.y + '%';
  el.style.fontSize = item.size + 'cqw';
  // A text near the right edge wraps instead of running off the picture.
  el.style.maxWidth = Math.max(12, 98 - item.x) + '%';
}

// Plain text only (textContent), never HTML. The brand style puts the logo in front and the
// last word in gold, like the built-in brand.
function loginTextElement(item) {
  const el = document.createElement('div');
  el.dataset.textId = item.id;
  placeLoginText(el, item);
  if (item.style === 'brand') {
    const mark = document.createElement('img');
    mark.className = 'login-text-mark';
    mark.src = assetUrl('brand-scales.png');
    mark.alt = '';
    const name = document.createElement('strong');
    const words = item.text.replace(/\s+/g, ' ').trim().split(' ');
    if (words.length > 1) {
      const last = document.createElement('span');
      last.textContent = words.at(-1);
      name.append(words.slice(0, -1).join(' ') + ' ', last);
    } else name.textContent = item.text;
    el.append(mark, name);
  } else el.textContent = item.text;
  return el;
}

function loginTextLayer(texts, layer = document.createElement('div')) {
  layer.classList.add('login-texts');
  layer.replaceChildren(...texts.map(loginTextElement));
  return layer;
}

let loginTextsRequest;
function savedLoginTexts() {
  loginTextsRequest ||= fetch('/api/login-texts', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : {}))
    .then((data) => (Array.isArray(data.texts) ? data.texts : null))
    .catch(() => null);
  return loginTextsRequest;
}

// The office's own texts replace the built-in ones. Until the answer arrives the built-in ones
// stay hidden so they do not flash; if it is slow, the built-in texts are shown and stay.
function placeLoginTexts(story) {
  if (!story) return;
  story.classList.add('login-story--pending');
  const timer = setTimeout(() => story.classList.remove('login-story--pending'), 2000);
  savedLoginTexts().then((texts) => {
    if (!story.classList.contains('login-story--pending')) return;
    clearTimeout(timer);
    if (texts) {
      story.classList.add('login-story--custom');
      story.append(loginTextLayer(texts));
    }
    story.classList.remove('login-story--pending');
  });
}

function loginFrame(content) {
  document.querySelector('aside').hidden = true;
  document.querySelector('.shell').hidden = true;
  let gate = document.getElementById('authGate');
  if (!gate) {
    gate = document.createElement('main');
    gate.id = 'authGate';
    document.body.append(gate);
  }
  if (!gate.querySelector('.login-card'))
    gate.innerHTML = `<section class="login-story" aria-label="HAN (PATAN) HUKUK">
      <img class="login-art" src="/api/login-art" alt="" width="1254" height="1254" fetchpriority="high" decoding="async">
      <div class="login-story-shade" aria-hidden="true"></div>
      ${loginBrand()}
      <div class="login-story-copy">
        <h2>Her dosyada özen.</h2>
        <p>Hukuk ve tahsilat yönetiminiz, tek bir çalışma alanında.</p>
      </div>
      <div class="login-story-footer">
        <span class="login-story-domain">hanhukuktakip.com</span>
        <a class="login-story-credit" href="https://www.emlakerp.com/" target="_blank" rel="noopener noreferrer">www.emlakerp.com</a>
      </div>
    </section>
    <section class="login-entry" aria-label="Hesap erişimi">
      <div class="login-entry-top">
        <div class="login-mobile-brand">${loginBrand()}</div>
      </div>
      <div class="login-card"></div>
      <div class="login-entry-footer"><span>HAN (PATAN) HUKUK</span><span data-login-version></span><a class="login-mobile-credit" href="https://www.emlakerp.com/" target="_blank" rel="noopener noreferrer">www.emlakerp.com</a></div>
    </section>`;
  // The office's own picture (Ayarlar → Firma Bilgileri); the built-in one if it cannot load.
  const art = gate.querySelector('.login-art:not([data-fallback])');
  if (art) {
    art.dataset.fallback = '1';
    art.addEventListener('error', () => (art.src = assetUrl('login-justice-v1.png')), { once: true });
    placeLoginTexts(gate.querySelector('.login-story'));
  }
  gate.querySelector('.login-card').innerHTML = content;
  const version = document.getElementById('appVersion')?.textContent.replace(/^●\s*/, '').trim();
  gate.querySelector('[data-login-version]').textContent = version || 'Hukuk ve Tahsilat Yönetimi';
  return gate;
}

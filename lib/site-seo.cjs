const fs = require('node:fs');
const path = require('node:path');

// What search engines see. Only the platform's public address (<base> and www.<base>) is
// meant to be found: there, visitors without a session get the product page (landing.html)
// and every office application, the operator console and the API answer with noindex.
// Staff of the existing office who are signed in keep getting their application on "/",
// and its sign-in screen also has its own address, /giris.

const LANDING_FILE = path.join(__dirname, '../outputs/icrapro/landing.html');
// Public files of the product page; everything else on every host is noindex.
const PUBLIC_ASSETS = new Set(['/landing-og.png', '/platform-icon.svg']);
const NOINDEX = 'noindex, nofollow';

const isMarketingHost = (host, base) => !!base && (host === base || host === 'www.' + base);
const siteOrigin = (base) => 'https://www.' + base;

// Same rule as lib/session-policy.cjs: exactly one well-formed han_session cookie.
function hasSessionCookie(req) {
  const matches = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('han_session='));
  return matches.length === 1 && /^[a-f0-9]{64}$/.test(matches[0].slice(12));
}

function robotsTxt({ marketing, origin }) {
  if (!marketing) return 'User-agent: *\nDisallow: /api/\n';
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`;
}

let landingModified;
function landingLastModified() {
  landingModified ||= fs.statSync(LANDING_FILE).mtime.toISOString().slice(0, 10);
  return landingModified;
}

function sitemapXml(origin) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url><loc>${origin}/</loc><lastmod>${landingLastModified()}</lastmod></url>\n` +
    '</urlset>\n'
  );
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// Contact details come from the server settings (HAN_SITE_CONTACT_EMAIL / _PHONE) so that
// nothing about the selling company is fixed in code; without them the page only offers sign-in.
function contactBlock({ email, phone }) {
  const mail = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(email || '') ? email : '';
  const tel = String(phone || '').trim();
  const telHref = tel.replace(/[^\d+]/g, '');
  if (!mail && telHref.length < 7) return '';
  const links = [
    mail
      ? `<a class="button primary" href="mailto:${escapeHtml(mail)}?subject=${encodeURIComponent('Hukuk Takip Platformu demo talebi')}">${escapeHtml(mail)}</a>`
      : '',
    telHref.length >= 7 ? `<a class="button" href="tel:${escapeHtml(telHref)}">${escapeHtml(tel)}</a>` : '',
  ].join('');
  return `<section class="contact" id="iletisim" aria-labelledby="iletisim-baslik">
        <div class="wrap">
          <h2 id="iletisim-baslik">Büronuz için demo isteyin</h2>
          <p>Kaç kullanıcıyla çalışacağınızı ve hangi modüllere ihtiyaç duyduğunuzu söyleyin; büronuza özel adresinizi açalım.</p>
          <p class="actions">${links}</p>
        </div>
      </section>`;
}

const landingCache = new Map();
function landingHtml(origin, contact = {}) {
  const key = [origin, contact.email || '', contact.phone || ''].join('\n');
  if (!landingCache.has(key)) {
    const block = contactBlock(contact);
    let html = fs.readFileSync(LANDING_FILE, 'utf8').replaceAll('__SITE_ORIGIN__', origin);
    html = html.replace('<!--CONTACT-->', block);
    // Without contact details the "Demo isteyin" links fall back to the sign-in address.
    if (!block)
      html = html
        .replaceAll('href="#iletisim"', 'href="/giris"')
        .replaceAll('>Demo isteyin<', '>Giriş yapın<');
    landingCache.set(key, html);
  }
  return landingCache.get(key);
}

function send(req, res, type, body, headers = {}) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Handles the search-engine side of a request on the own server. Returns true when it
// answered; otherwise it may rewrite req.url and sets the noindex header for the rest.
function handleSeo(req, res, { host, pathname, base, contact = {} }) {
  const marketing = isMarketingHost(host, base);
  const origin = siteOrigin(base);
  const readable = req.method === 'GET' || req.method === 'HEAD';
  if (readable && pathname === '/robots.txt') {
    send(req, res, 'text/plain; charset=utf-8', robotsTxt({ marketing, origin }), {
      'Cache-Control': 'public, max-age=3600',
    });
    return true;
  }
  if (marketing && readable && pathname === '/sitemap.xml') {
    send(req, res, 'application/xml; charset=utf-8', sitemapXml(origin), {
      'Cache-Control': 'public, max-age=3600',
    });
    return true;
  }
  if (marketing && pathname === '/') {
    // The same address answers differently with and without a session.
    res.setHeader('Vary', 'Cookie');
    res.setHeader('Cache-Control', 'private, no-cache');
    if (readable && !hasSessionCookie(req)) {
      send(req, res, 'text/html; charset=utf-8', landingHtml(origin, contact), {
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      return true;
    }
  }
  if (marketing && pathname === '/giris') {
    const query = req.url.indexOf('?');
    req.url = '/index.html' + (query === -1 ? '' : req.url.slice(query));
  }
  if (!(marketing && PUBLIC_ASSETS.has(pathname))) res.setHeader('X-Robots-Tag', NOINDEX);
  return false;
}

module.exports = {
  handleSeo,
  robotsTxt,
  sitemapXml,
  landingHtml,
  hasSessionCookie,
  isMarketingHost,
  siteOrigin,
};

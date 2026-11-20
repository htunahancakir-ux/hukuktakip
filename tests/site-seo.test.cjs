const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  robotsTxt,
  sitemapXml,
  landingHtml,
  hasSessionCookie,
  isMarketingHost,
} = require('../lib/site-seo.cjs');

const ORIGIN = 'https://www.han.example.com';
const TOKEN = 'a'.repeat(64);

test('only the bare domain and www are the public site', () => {
  assert.equal(isMarketingHost('han.example.com', 'han.example.com'), true);
  assert.equal(isMarketingHost('www.han.example.com', 'han.example.com'), true);
  for (const host of ['admin.han.example.com', 'deneme.han.example.com', 'evil.com', ''])
    assert.equal(isMarketingHost(host, 'han.example.com'), false, host);
  assert.equal(isMarketingHost('anything', ''), false);
});

test('robots.txt points the public site to its sitemap and keeps the API out', () => {
  const site = robotsTxt({ marketing: true, origin: ORIGIN });
  assert.match(site, /^User-agent: \*$/m);
  assert.match(site, /^Disallow: \/api\/$/m);
  assert.match(site, new RegExp(`^Sitemap: ${ORIGIN}/sitemap.xml$`, 'm'));
  const office = robotsTxt({ marketing: false, origin: ORIGIN });
  assert.doesNotMatch(office, /Sitemap/);
});

test('the sitemap lists the product page with an ISO date', () => {
  const xml = sitemapXml(ORIGIN);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, new RegExp(`<loc>${ORIGIN}/</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
});

test('a session cookie is recognized only when well formed and unambiguous', () => {
  const req = (cookie) => ({ headers: { cookie } });
  assert.equal(hasSessionCookie(req(`han_session=${TOKEN}`)), true);
  assert.equal(hasSessionCookie(req(`x=1; han_session=${TOKEN}`)), true);
  assert.equal(hasSessionCookie(req('han_session=')), false);
  assert.equal(hasSessionCookie(req('han_session=zz')), false);
  assert.equal(hasSessionCookie(req(`han_session=${TOKEN}; han_session=${TOKEN}`)), false);
  assert.equal(hasSessionCookie({ headers: {} }), false);
});

test('the product page carries search metadata and no office name', () => {
  const html = landingHtml(ORIGIN);
  assert.doesNotMatch(html, /__SITE_ORIGIN__|<!--CONTACT-->/);
  assert.match(html, /<html lang="tr">/);
  assert.match(html, /<title>[^<]{20,80}<\/title>/);
  const description = /<meta\s+name="description"\s+content="([^"]+)"/.exec(html)?.[1];
  assert.ok(description && description.length >= 70 && description.length <= 160, description);
  assert.match(html, new RegExp(`<link rel="canonical" href="${ORIGIN}/" />`));
  assert.match(html, new RegExp(`<meta property="og:image" content="${ORIGIN}/landing-og.png" />`));
  assert.equal(html.match(/<h1[\s>]/g).length, 1);
  // Structured data is valid JSON.
  const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1];
  const data = JSON.parse(json);
  assert.ok(data['@graph'].some((node) => node['@type'] === 'SoftwareApplication'));
  // White label: the page sells the platform, never one office.
  assert.doesNotMatch(html, /PATAN|HAN \(|Han Hukuk|Bahadır/i);
  // No scripts other than the structured data, no external resources.
  assert.equal(html.match(/<script/g).length, 1);
  assert.doesNotMatch(html, /\ssrc="https?:\/\//);
  // The only link off the site is the product credit (2.7.2), opened in a new tab without
  // handing over the page.
  const outside = [...html.matchAll(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)].filter(
    ([, url]) => !url.startsWith(ORIGIN + '/'),
  );
  assert.deepEqual(
    outside.map(([, url]) => url),
    ['https://www.kodlinx.com.tr/'],
  );
  assert.match(outside[0][0], /target="_blank"/);
  assert.match(outside[0][0], /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<link\s[^>]*href="https?:\/\/(?!www\.han\.example\.com)/);
  // Without contact details every "Demo isteyin" leads to sign-in.
  assert.doesNotMatch(html, /href="#iletisim"/);
});

test('contact details from the settings are escaped into the page', () => {
  const html = landingHtml(ORIGIN, { email: 'satis@example.com', phone: '0 (212) 555 00 00' });
  assert.match(html, /id="iletisim"/);
  assert.match(html, /href="mailto:satis@example.com\?subject=/);
  assert.match(html, /href="tel:02125550000"/);
  assert.match(html, /href="#iletisim"/);
  const hostile = landingHtml(ORIGIN, { email: '"><script>x</script>@a.com', phone: '<b>' });
  assert.doesNotMatch(hostile, /<script>x/);
  assert.doesNotMatch(hostile, /id="iletisim"/);
});

test('the page assets are served from the application allowlist', () => {
  const root = path.join(__dirname, '../outputs/icrapro');
  for (const file of ['landing.html', 'landing-og.png', 'platform-icon.svg'])
    assert.ok(fs.existsSync(path.join(root, file)), file);
  const png = fs.readFileSync(path.join(root, 'landing-og.png'));
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function secureCookiesRequired({ secureCookies = false, appOrigin } = {}) {
  return secureCookies || /^https:\/\//i.test(appOrigin || '');
}

function targetOrigin(req, { appOrigin, secureCookies = false } = {}) {
  try {
    // A production origin is configuration, never inferred from proxy/Host headers.
    if (secureCookies && !appOrigin) return '';
    const url = new URL(appOrigin || 'http://' + req.headers.host);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    if (!['http:', 'https:'].includes(url.protocol) || (secureCookies && url.protocol !== 'https:'))
      return '';
    return url.origin;
  } catch {
    return '';
  }
}

function mutationSourceAllowed(req, options = {}) {
  if (SAFE_METHODS.has(req.method)) return true;
  const headers = req.headers;
  // HTML forms cannot set this header. Cross-origin JS needs a CORS preflight;
  // this application never enables cross-origin credentialed API requests.
  if (headers['x-han-request'] !== '1') return false;
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false; // also distrust sibling subdomains
  const expected = targetOrigin(req, options);
  if (!expected) return false;
  if (headers.origin !== undefined) return headers.origin === expected;
  if (headers.referer !== undefined) {
    try {
      return new URL(headers.referer).origin === expected;
    } catch {
      return false;
    }
  }
  // Older same-origin clients may omit Origin; require browser provenance in
  // HTTPS deployments. Local CLI/test clients still need the custom header.
  return site === 'same-origin' || !options.secureCookies;
}

module.exports = { mutationSourceAllowed, secureCookiesRequired };

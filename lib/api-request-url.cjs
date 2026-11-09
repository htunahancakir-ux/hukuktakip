// Vercel may supply rewrite/original query values separately from req.url.
function apiRequestUrl(req) {
  const url = new URL(req.url, 'https://localhost');
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === 'route' || url.searchParams.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string') url.searchParams.append(key, item);
    }
  }
  const route = req.query?.route || url.searchParams.get('route');
  if (typeof route === 'string') url.pathname = '/api/' + route;
  url.searchParams.delete('route');
  return url.pathname + url.search;
}
module.exports = { apiRequestUrl };

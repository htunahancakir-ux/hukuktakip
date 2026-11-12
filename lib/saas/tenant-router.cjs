const { createTenantResolver } = require('./tenant-resolver.cjs');

const MAX_HANDLERS = 50;

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status === 500) console.error('Tenant routing failed');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: status === 500 ? 'Sunucu hatası.' : error.message }));
}

// One application handler per office, created lazily. `createHandler` receives
// the server-resolved tenant ({ tenantId, slug }) and must bind its store and
// allowed origin to it. Nothing the browser sends selects the tenant except
// the Host header, which the platform edge sets for the requested domain.
function createTenantRouter({ pool, createHandler, createPlatformHandler, baseDomain, cacheMs }) {
  const resolver = createTenantResolver(pool, { baseDomain, cacheMs });
  const handlers = new Map();
  let platformHandler;
  return async function route(req, res) {
    let tenant;
    try {
      tenant = await resolver.resolve(req);
    } catch (error) {
      return sendError(res, error);
    }
    if (tenant.platform) {
      // The operator console host: its own handler, never an office application.
      if (!createPlatformHandler) return sendError(res, Object.assign(new Error('Büro bulunamadı.'), { status: 404 }));
      platformHandler ||= createPlatformHandler({ baseDomain: resolver.baseDomain });
      return platformHandler(req, res);
    }
    let handler = handlers.get(tenant.tenantId);
    if (!handler) {
      if (handlers.size >= MAX_HANDLERS) handlers.delete(handlers.keys().next().value);
      handler = createHandler({ ...tenant, baseDomain: resolver.baseDomain });
      handlers.set(tenant.tenantId, handler);
    }
    return handler(req, res);
  };
}

module.exports = { createTenantRouter };

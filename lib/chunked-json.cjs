const crypto = require('node:crypto');
function chunkedJson(req, res) {
  if (req.method !== 'GET' || req.headers['x-han-chunk-transport'] !== '1') return;
  const originalEnd = res.end.bind(res);
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, headers = {}) => {
    const type = headers['content-type'] || headers['Content-Type'] || res.getHeader('Content-Type') || '';
    if (!String(type).includes('application/json')) return writeHead(status, headers);
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  const end = (...args) => {
    if (!res.headersSent) writeHead(res.statusCode);
    return originalEnd(...args);
  };
  res.end = (body, ...args) => {
    const type = String(res.getHeader('Content-Type') || '');
    const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
    if (type.includes('application/json') && text.length > 524288) {
      const url = new URL(req.url, 'http://localhost');
      const offset = Number(url.searchParams.get('_hanChunk') || req.query?._hanChunk || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) {
        res.statusCode = 400;
        return end(JSON.stringify({ error: 'Geçersiz dosya parçası.' }));
      }
      res.setHeader('X-Han-Chunked', '1');
      res.removeHeader('Content-Length');
      return end(
        JSON.stringify({
          hash: crypto.createHash('sha256').update(text).digest('hex'),
          offset,
          total: text.length,
          chunk: text.slice(offset, offset + 524288),
        }),
      );
    }
    return end(body, ...args);
  };
}
module.exports = { chunkedJson };

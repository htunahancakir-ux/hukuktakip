// Cloudflare sits in front of our own server and replaces any 502 or 504 answer of the origin
// with its own HTML error page. The application uses those two codes for "an outside service
// (Verimor, SMS, AI, maps, iyzico…) failed or did not answer", always with a JSON body that
// tells the user what happened and what to do (e.g. "Arama başladıysa tekrar başlatmayın").
// Replaced by HTML, the browser could only show "Unexpected token '<'". 424 (Failed Dependency)
// means the same thing and passes through the proxy untouched, so the message arrives.
const REPLACED_BY_PROXY = new Set([502, 504]);
const SAFE_STATUS = 424;

function keepErrorsPastProxy(res) {
  const writeHead = res.writeHead;
  // Node's implicit header write (res.statusCode + res.end) also goes through writeHead.
  res.writeHead = function (status, ...rest) {
    return writeHead.call(this, REPLACED_BY_PROXY.has(Number(status)) ? SAFE_STATUS : status, ...rest);
  };
  return res;
}

module.exports = { keepErrorsPastProxy, SAFE_STATUS };

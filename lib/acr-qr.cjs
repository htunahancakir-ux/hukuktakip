const qrcode = require('qrcode-generator');

function pairingQr(host, code) {
  const hostname = String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!/^[a-z0-9.-]+$/.test(hostname)) throw Error('Büro adresi geçersiz.');
  const qr = qrcode(0, 'M');
  qr.addData(`https://${hostname}/${code}`);
  qr.make();
  return { qrCodeDataUrl: qr.createDataURL(5, 20), qrSize: (qr.getModuleCount() + 8) * 5 };
}

module.exports = { pairingQr };

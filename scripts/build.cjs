const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { files } = require('../lib/application.cjs');
const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'outputs/icrapro');
const publicRoot = path.join(root, 'public');
const assetHash = crypto.createHash('sha256');
for (const file of [...files].sort()) {
  assetHash
    .update(file)
    .update('\0')
    .update(fs.readFileSync(path.join(sourceRoot, file)));
}
const assetVersion = assetHash.digest('hex').slice(0, 16);

fs.mkdirSync(publicRoot, { recursive: true });
for (const file of files) {
  const source = path.join(sourceRoot, file);
  const destination = path.join(publicRoot, file);
  if (file.endsWith('.html'))
    fs.writeFileSync(
      destination,
      fs.readFileSync(source, 'utf8').replaceAll('__ASSET_VERSION__', assetVersion),
    );
  else fs.copyFileSync(source, destination);
}
console.log(`Built public frontend (allowlisted browser files only, assets ${assetVersion}).`);

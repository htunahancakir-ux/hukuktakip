const fs = require('node:fs');
const path = require('node:path');
const { files } = require('../lib/application.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, 'outputs/icrapro', file), path.join(root, 'public', file));
console.log('Built public frontend (allowlisted browser files only).');

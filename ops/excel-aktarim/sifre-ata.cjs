// Excel aktarımı kullanıcısına rastgele bir şifre atar.
//
//   node sifre-ata.cjs /root/han-excel-aktarim/sifre.txt
//
// Şifre yalnızca verilen dosyaya (yalnızca root okuyabilir) yazılır; ekrana, kabuk geçmişine ya
// da PostgreSQL günlüğüne düşmez: sunucuya şifrenin kendisi değil SCRAM-SHA-256 özeti gönderilir
// (psql'in \password komutunun yaptığı şey). Yeniden çalıştırmak şifreyi değiştirir.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const file = process.argv[2];
if (!file || !path.isAbsolute(file)) {
  console.error('Şifre dosyasının tam yolunu verin.');
  process.exit(1);
}
const ROLE = 'han_excel_aktarim';
// 32 characters from A-Z a-z 0-9 - _ (192 bits); safe in every connection string.
const password = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(16);
const iterations = 4096;
const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
const storedKey = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
const serverKey = hmac(salted, 'Server Key');
const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;

fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file, password + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
// The statement goes in on standard input, so it is not in the process list either.
execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], {
  input: `ALTER ROLE ${ROLE} PASSWORD '${verifier}';\n`,
  stdio: ['pipe', 'ignore', 'inherit'],
});
console.log(`Şifre atandı (${password.length} karakter). Dosya: ${file}`);

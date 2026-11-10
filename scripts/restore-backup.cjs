const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const { decryptState } = require('../lib/backup-service.cjs');
const { createPool, importState, validateState } = require('../lib/postgres-store.cjs');
const { inTransaction } = require('../lib/db-transaction.cjs');
const { restoreAudit, validateAudit } = require('../lib/record-store/backup.cjs');

function authorizeRestore(state, { username, password }) {
  const normalized = String(username || '')
    .trim()
    .toLocaleLowerCase('tr');
  const ceo = state.users.find(
    (user) =>
      user.username === normalized &&
      user.role === 'ceo' &&
      user.active &&
      (!user.staffId ||
        state.data['icrapro-personnel-v1'].some(
          (person) => person.id === user.staffId && person.active !== false,
        )),
  );
  if (
    !ceo ||
    typeof password !== 'string' ||
    !crypto.timingSafeEqual(crypto.scryptSync(password, ceo.salt, 64), Buffer.from(ceo.hash, 'hex'))
  )
    throw new Error('Geri yükleme için yedekteki etkin CEO hesabı ve doğru şifre gerekli.');
}

async function restoreBackup({ file, rawKey, localTarget, credentials }) {
  if (!/^[a-f0-9]{64}$/i.test(rawKey || ''))
    throw new Error('Geri yükleme için BACKUP_ENCRYPTION_KEY gerekli.');
  const encrypted = await fs.promises.readFile(file);
  let state;
  try {
    state = decryptState(encrypted, Buffer.from(rawKey, 'hex'));
  } catch {
    throw new Error('Yedek açılamadı. Dosyayı ve şifreleme anahtarını kontrol edin.');
  }
  validateState(state);
  authorizeRestore(state, await credentials());
  const auditBundle = state._hanBackup;
  validateAudit(auditBundle);
  delete state._hanBackup;
  delete state.backupPolicy;
  delete state.whatsappConfig;
  delete state.mapsConfig;
  delete state.passwordRecovery;
  delete state.reminderScheduler;
  for (const reminder of state.scheduledReminders || []) {
    if (['pending', 'sending'].includes(reminder.deliveryStatus)) {
      reminder.deliveryStatus = 'cancelled';
      delete reminder.phoneHash;
    }
  }
  if (!localTarget && process.env.DATABASE_URL) {
    const pool = createPool();
    try {
      await inTransaction(pool, async (db) => {
        await importState(db, state);
        await restoreAudit(db, auditBundle);
      });
    } catch (error) {
      if (error.code === '23505') throw new Error('Hedef veritabanında kayıt var. Boş bir hedef seçin.');
      throw error;
    } finally {
      await pool.end();
    }
    return 'Yedek boş PostgreSQL veritabanına aktarıldı.';
  }
  const target =
    localTarget || process.env.HANHUKUK_STATE_FILE || path.resolve(__dirname, '../work/hanhukuk-state.json');
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const auditTarget = path.join(path.dirname(target), 'audit-events.jsonl');
  let auditCreated = false;
  try {
    if (auditBundle) {
      const rows = auditBundle.audit.map(({ occurred_at, ...row }) =>
        JSON.stringify({ ...row, at: occurred_at }),
      );
      await fs.promises.writeFile(auditTarget, rows.join('\n') + (rows.length ? '\n' : ''), {
        flag: 'wx',
        mode: 0o600,
      });
      auditCreated = true;
    }
    await fs.promises.writeFile(target, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (auditCreated) await fs.promises.unlink(auditTarget);
    if (error.code === 'EEXIST') throw new Error('Hedef dosya zaten var. Yeni bir dosya yolu seçin.');
    throw error;
  }
  return 'Yedek yerel dosyaya aktarıldı: ' + path.resolve(target);
}

async function promptCeo() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('CEO doğrulaması için komutu bir terminalde çalıştırın.');
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hidden) process.stdout.write(chunk);
      done();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  terminal.on('SIGINT', () => abort.abort());
  terminal.on('close', () => abort.abort());
  try {
    const username = await terminal.question('CEO kullanıcı adı: ', { signal: abort.signal });
    process.stdout.write('CEO şifresi: ');
    hidden = true;
    const password = await terminal.question('', { signal: abort.signal });
    return { username, password };
  } finally {
    if (hidden) process.stdout.write('\n');
    terminal.close();
  }
}

async function main() {
  const [file, option, localTarget, ...extra] = process.argv.slice(2);
  if (!file || extra.length || (option !== undefined && (option !== '--local' || !localTarget)))
    throw new Error('Kullanım: npm run backup:restore -- YEDEK.hnb [--local YENI-DOSYA.json]');
  console.log(
    await restoreBackup({
      file,
      localTarget,
      rawKey: process.env.BACKUP_ENCRYPTION_KEY,
      credentials: promptCeo,
    }),
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.name === 'AbortError' ? 'Geri yükleme iptal edildi.' : error.message);
    process.exitCode = 1;
  });

module.exports = { restoreBackup };

const fs = require('node:fs/promises');
const path = require('node:path');
function createHotCache(directory, { maxBytes = 256 * 1024 * 1024, maxEntries = 256, ttl = 86400000 } = {}) {
  const root = path.resolve(directory);
  let cleanup = Promise.resolve();
  const file = (id) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Geçersiz önbellek kimliği.');
    return path.join(root, id + '.enc');
  };
  async function drop(id) {
    await fs.unlink(file(id)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async function trim(newestId) {
    const names = (await fs.readdir(root)).filter((name) => /^[a-f0-9-]{36}\.enc$/i.test(name));
    const entries = (
      await Promise.all(
        names.map(async (name) => {
          try {
            const stat = await fs.stat(path.join(root, name));
            return { name, size: stat.size, time: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
      )
    )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.time - b.time ||
          (a.name === newestId + '.enc'
            ? 1
            : b.name === newestId + '.enc'
              ? -1
              : a.name.localeCompare(b.name)),
      );
    let bytes = entries.reduce((n, e) => n + e.size, 0),
      count = entries.length;
    for (const entry of entries)
      if (Date.now() - entry.time > ttl || bytes > maxBytes || count > maxEntries) {
        await fs.unlink(path.join(root, entry.name)).catch(() => {});
        bytes -= entry.size;
        count--;
      }
  }
  return {
    drop,
    async get(id) {
      try {
        const name = file(id),
          stat = await fs.stat(name);
        if (Date.now() - stat.mtimeMs > ttl) {
          await drop(id);
          return null;
        }
        const bytes = await fs.readFile(name);
        await fs.utimes(name, new Date(), new Date());
        return bytes;
      } catch {
        return null;
      }
    },
    async put(id, bytes) {
      if (bytes.length > maxBytes) return;
      await fs.mkdir(root, { recursive: true });
      const name = file(id),
        temp = name + '.' + require('node:crypto').randomUUID() + '.tmp';
      try {
        await fs.writeFile(temp, bytes, { mode: 0o600 });
        await fs.rename(temp, name);
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
      cleanup = cleanup.catch(() => {}).then(() => trim(id));
      await cleanup;
    },
  };
}
function isHot(call, status) {
  return !!status && status !== 'İnfaz' && Date.now() - Date.parse(call.createdAt) < 30 * 86400000;
}
function forCall(state, call) {
  if (Object.hasOwn(state.voipDocumentStates || {}, call.documentId))
    return isHot(call, state.voipDocumentStates[call.documentId] || 'Derdest');
  const doc = state.data?.['icrapro-v1']?.docs?.find((d) => d.id === call.documentId);
  if (doc) return isHot(call, doc.status || 'Derdest');
  return isHot(
    call,
    state.voipDocumentStates?.[call.documentId] ??
      state.data?.['icrapro-v1']?.docs?.find((d) => d.id === call.documentId)?.status,
  );
}
module.exports = { createHotCache, isHot, forCall };

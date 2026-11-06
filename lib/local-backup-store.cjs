const fs = require('node:fs');
const path = require('node:path');

function createLocalBackupStore(stateFile) {
  const policyFile = path.join(path.dirname(stateFile), 'backup-settings.json');
  let pending = Promise.resolve();
  function readPolicy() {
    try { return JSON.parse(fs.readFileSync(policyFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  return {
    async readPolicy() { return readPolicy(); },
    async readState() { return JSON.parse(await fs.promises.readFile(stateFile, 'utf8')); },
    updatePolicy(change) {
      const task = pending.then(async () => {
        const policy = readPolicy();
        const result = change(policy);
        if (result === null) return null;
        await fs.promises.mkdir(path.dirname(policyFile), { recursive: true });
        const temporary = policyFile + '.tmp';
        await fs.promises.writeFile(temporary, JSON.stringify(policy), { mode: 0o600 });
        await fs.promises.rename(temporary, policyFile);
        return result;
      });
      pending = task.catch(() => {});
      return task;
    }
  };
}
module.exports = { createLocalBackupStore };

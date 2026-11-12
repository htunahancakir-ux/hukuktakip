const crypto = require('node:crypto');
const wa = require('./whatsapp.cjs');

const zone = 'Europe/Istanbul';
const digest = (key) => crypto.createHash('sha256').update(key).digest('hex');
const stamp = (now) => new Date(now).toISOString();

function userActive(state, user) {
  return Boolean(
    user?.active &&
    (!user.staffId ||
      state.data['icrapro-personnel-v1'].some(
        (person) => person.id === user.staffId && person.active !== false,
      )),
  );
}

function deliveryAvailable(state, user, schedulerConfigured) {
  const config = state.whatsappConfig;
  return Boolean(
    schedulerConfigured && config?.enabled && config.reminderTemplate && wa.contactPhone(state, user),
  );
}

function targetFor(state, user, type, id) {
  const manager = ['ceo', 'admin'].includes(user.role);
  const { clients, docs } = state.data['icrapro-v1'];
  if (type === 'client' && (manager || user.permissions?.includes('clients'))) {
    const row = clients.find((client) => client.id === id);
    if (row) return { type, id, label: row.name };
  }
  if (type === 'document') {
    const row = docs.find(
      (doc) => doc.id === id && (manager || (user.staffId && user.staffId === doc.relatedStaff)),
    );
    if (row)
      return {
        type,
        id,
        label: row.debtor,
        detail: [row.number, row.enforcementFileNumber].filter(Boolean).join(' / '),
      };
  }
  return null;
}

function scheduleTime(date, time, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const parsed = Date.parse(date + 'T' + time + ':00+03:00');
  if (!Number.isFinite(parsed) || parsed <= now) return null;
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(parsed));
  return local === date + ' ' + time ? stamp(parsed) : null;
}

function schedulerAuthorized(state, secret) {
  const expected = state.reminderScheduler?.hash || '';
  return (
    /^[a-f0-9]{64}$/.test(expected) &&
    /^[a-f0-9]{64}$/.test(secret) &&
    crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest(secret), 'hex'))
  );
}

async function deliverScheduledReminders(transaction, { authorize, fetcher, now = Date.now() } = {}) {
  const batch = await transaction(
    ({ state, saveState }) => {
      if (!authorize(state)) return null;
      const config = state.whatsappConfig;
      const rows = state.scheduledReminders || [];
      let changed = false;
      const jobs = [];
      const setStatus = (row, status) => {
        row.deliveryStatus = status;
        row.deliveryUpdatedAt = stamp(now);
        changed = true;
      };
      for (const row of rows) {
        if (row.deliveryStatus === 'sending' && Date.parse(row.deliveryUpdatedAt) + 180000 <= now) {
          setStatus(row, 'unknown');
        }
        if (
          row.closedAt ||
          row.deliveryStatus !== 'pending' ||
          Date.parse(row.dueAt) > now ||
          jobs.length >= 12
        )
          continue;
        const user = state.users.find((account) => account.id === row.accountId);
        if (!userActive(state, user) || !deliveryAvailable(state, user, true)) {
          setStatus(row, 'unavailable');
          continue;
        }
        const phone = wa.contactPhone(state, user);
        // Phone and consent are rechecked at delivery; an account change must not redirect an old request.
        if (row.phoneHash !== digest(phone)) {
          setStatus(row, 'unavailable');
          continue;
        }
        setStatus(row, 'sending');
        jobs.push({
          id: row.id,
          to: phone,
          values: [
            'Han Hukuk Takip',
            'Planladığınız hatırlatmanın zamanı geldi. Ayrıntılar: https://www.hanhukuktakip.com',
            new Intl.DateTimeFormat('tr-TR', {
              timeZone: zone,
              dateStyle: 'short',
              timeStyle: 'short',
            }).format(new Date(row.dueAt)),
          ],
        });
      }
      if (changed) saveState(state);
      return { config, jobs };
    },
    { now },
  );
  if (!batch) return null;
  const results = await Promise.all(
    batch.jobs.map(async (job) => {
      const delivery = await wa.deliverWhatsApp(
        {
          config: batch.config,
          template: 'reminderTemplate',
          jobs: [job],
        },
        { fetcher },
      );
      const error = !delivery.accepted && delivery.errors?.[0];
      return {
        id: job.id,
        status: delivery.accepted ? 'accepted' : 'failed',
        error: error ? (error.code ? 'Hata ' + error.code + ': ' : '') + error.message : '',
      };
    }),
  );
  if (results.length)
    await transaction(
      ({ state, saveState }) => {
        const outcomes = new Map(results.map((result) => [result.id, result]));
        for (const row of state.scheduledReminders || []) {
          if (outcomes.has(row.id) && row.deliveryStatus === 'sending') {
            const outcome = outcomes.get(row.id);
            row.deliveryStatus = outcome.status;
            if (outcome.error) row.deliveryError = outcome.error;
            else delete row.deliveryError;
            row.deliveryUpdatedAt = stamp(Date.now());
          }
        }
        saveState(state);
      },
      { reminderIds: results.map((row) => row.id) },
    );
  return { processed: results.length, accepted: results.filter((row) => row.status === 'accepted').length };
}

module.exports = {
  digest,
  deliveryAvailable,
  scheduleTime,
  targetFor,
  schedulerAuthorized,
  deliverScheduledReminders,
};

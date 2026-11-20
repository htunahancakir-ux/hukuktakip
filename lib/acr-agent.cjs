const crypto = require('node:crypto');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function matches(value, hash) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/.test(hash || '') &&
    crypto.timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'))
  );
}

function linkDevice(state, deviceId, revoke) {
  const owner = state.voipConfig?.acrDevices?.[deviceId]?.userId;
  const agents = { ...state.voipConfig?.acrAgents };
  if (revoke) {
    delete agents[deviceId];
    state.voipConfig = { ...state.voipConfig, acrAgents: agents };
    return { paired: false };
  }
  if (!owner) return null;
  const code = crypto.randomBytes(12).toString('base64url');
  agents[deviceId] = { owner, pairHash: digest(code), pairUntil: Date.now() + 10 * 60000 };
  state.voipConfig = { ...state.voipConfig, acrAgents: agents };
  return { pairingCode: deviceId + '.' + code };
}

function agentFor(state, id) {
  const profile = state.voipConfig?.acrDevices?.[id];
  const agent = state.voipConfig?.acrAgents?.[id];
  return agent?.owner && profile?.userId === agent.owner ? agent : null;
}

function pairDevice(state, id, code) {
  const link = agentFor(state, id);
  if (!link || link.pairUntil < Date.now() || !matches(code, link.pairHash)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  state.voipConfig = {
    ...state.voipConfig,
    acrAgents: {
      ...state.voipConfig.acrAgents,
      [id]: { owner: link.owner, generation: crypto.randomUUID(), tokenHash: digest(token) },
    },
  };
  return { deviceId: id, accountId: link.owner, token };
}

function pendingDial(state, id, accountId, token, now) {
  const agent = agentFor(state, id);
  if (agent?.owner !== accountId || !matches(token, agent?.tokenHash)) return undefined;
  return (
    (state.acrOutboundDials || []).find(
      (dial) =>
        dial.userId === accountId &&
        dial.deviceId === id &&
        dial.agentGeneration === agent.generation &&
        !dial.callId &&
        !dial.readyAt &&
        dial.dispatchBefore > now,
    ) || null
  );
}

module.exports = { agentFor, linkDevice, pairDevice, pendingDial };

const channels = require('../../lib/recovery-channels.cjs');

// An office WhatsApp setup complete enough to send a password link.
const WHATSAPP = Object.freeze({
  enabled: true,
  resetTemplate: 'x',
  sealedToken: 'sealed-synthetic-token',
  phoneNumberId: '100000000000001',
});

// Marks the office's own recovery channels (all that are set up, or the named ones) as having
// passed their live delivery test with the setup saved in `state`, as the CEO's test would.
function liveTested(state, ...names) {
  for (const name of names.length ? names : ['sms', 'whatsapp']) {
    const stamp = channels.stamp(state, name);
    if (stamp)
      state.recoveryChannelReadiness = {
        ...state.recoveryChannelReadiness,
        [name]: { stamp, verifiedAt: new Date().toISOString() },
      };
  }
  return state;
}

module.exports = { liveTested, WHATSAPP };

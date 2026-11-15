const smsSettings = require('./sms-settings.cjs');

// The ways "Şifremi unuttum" can reach a user, and the order they are tried in.
//
//   whatsapp  the office's own WhatsApp Business integration (a password link)
//   sms       the office's own Verimor account, or else the platform's SMS service
//   email     the platform's e-mail service (Brevo)
//
// The office CEO picks the first one (Ayarlar → Entegrasyonlar → Şifre Yenileme, saved as
// `recoveryPolicy.primary`); the others stay offered when a code does not arrive. Without a
// choice the long-standing order applies: WhatsApp, then SMS, then e-mail. When none is open, or
// none reaches the user, "Yöneticiden iste" sends the request to the office's managers.

const CHANNELS = Object.freeze(['whatsapp', 'sms', 'email']);
const LABELS = Object.freeze({ whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-posta' });

function availableChannels(state, options = {}) {
  const wa = state.whatsappConfig;
  return {
    whatsapp: !!(wa?.enabled && wa.resetTemplate),
    sms: smsSettings.publicConfig(state.smsConfig).enabled || options.smsAvailable === true,
    email: options.emailAvailable === true,
  };
}

// Open channels, the office's first choice first.
function channelOrder(state, available) {
  const open = CHANNELS.filter((channel) => available[channel]);
  const primary = state.recoveryPolicy?.primary;
  return open.includes(primary) ? [primary, ...open.filter((channel) => channel !== primary)] : open;
}

function cleanPolicy(input, fail) {
  const primary = input?.primary;
  if (!CHANNELS.includes(primary)) throw fail(400, 'İlk yöntem olarak WhatsApp, SMS veya e-posta seçin.');
  return { primary };
}

module.exports = { CHANNELS, LABELS, availableChannels, channelOrder, cleanPolicy };

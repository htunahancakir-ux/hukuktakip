const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
function passwordValid(password) {
  return typeof password === 'string' && password.length >= 10 && password.length <= 128;
}
async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 64)).toString('hex');
}
async function verifyPassword(password, user) {
  if (typeof password !== 'string' || password.length > 128 || !/^[a-f0-9]{128}$/i.test(user?.hash || ''))
    return false;
  const actual = Buffer.from(await hashPassword(password, user.salt), 'hex');
  return crypto.timingSafeEqual(actual, Buffer.from(user.hash, 'hex'));
}
module.exports = { hashPassword, verifyPassword, passwordValid };

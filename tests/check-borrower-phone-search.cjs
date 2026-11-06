const fs = require('fs'),
  vm = require('vm'),
  assert = require('assert/strict');
const s = fs.readFileSync('outputs/icrapro/client-records.js', 'utf8'),
  fn = s.slice(s.indexOf('function borrowerPhoneMatches('), s.indexOf('function matchesGlobalSearch('));
const c = {};
vm.createContext(c);
vm.runInContext(fn, c);
const d = { phone1: '0 (532) 123-45-67', additionalPhones: ['+90 555 111 22 33'] };
assert.equal(c.borrowerPhoneMatches(d, '05321234567'), true);
assert.equal(c.borrowerPhoneMatches(d, '+90 532 123 45 67'), true);
assert.equal(c.borrowerPhoneMatches(d, '05551112233'), true);
assert.equal(c.borrowerPhoneMatches(d, '1234567'), true);
assert.equal(c.borrowerPhoneMatches(d, '9999999'), false);
console.log('PASS: phone search formatting, country prefix, extra numbers and partial matches.');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localAddresses } = require('../dist/network');
const address = (value, extra = {}) => ({ address: value, family: 'IPv4', internal: false, ...extra });

test('LAN discovery offers private IPv4 addresses and prefers LAN adapters over virtual bridges', () => {
  const result = localAddresses({
    lo: [address('127.0.0.1', { internal: true })],
    eth0: [address('192.168.1.20'), address('2001:db8::1', { family: 'IPv6' })],
    wlan0: [address('10.0.0.12')],
    other: [address('192.168.1.20')],
    docker0: [address('172.17.0.1')],
    tailscale0: [address('10.20.0.1')],
    public: [address('203.0.113.20'), address('172.32.0.1'), address('192.168.300.1')]
  });
  assert.deepEqual(result, [{ name: 'eth0', address: '192.168.1.20' }, { name: 'wlan0', address: '10.0.0.12' }]);
  assert.deepEqual(localAddresses({ docker0: [address('172.17.0.1')] }), [{ name: 'docker0', address: '172.17.0.1' }]);
  assert.deepEqual(localAddresses({ en0: [address('169.254.20.5')] }), [{ name: 'en0', address: '169.254.20.5' }]);
  assert.deepEqual(localAddresses({ lo: [address('127.0.0.1', { internal: true })] }), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, parseMonitorUrl, validateTarget } from '../src/url-safety.ts';

test('private, reserved, metadata and multicast IPv4 addresses are denied', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34']) assert.equal(isPublicAddress(ip), true, ip);
});
test('IPv6 private, mapped, documentation and transition networks are denied', () => {
  for (const ip of ['::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '2001::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});
test('IPv6 special-purpose exclusion stops before the public 2001:200 boundary', () => {
  assert.equal(isPublicAddress('2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'), false);
  for (const ip of ['2001:200::', '2001:0200::1', '2001:201::1']) assert.equal(isPublicAddress(ip), true, ip);
});
test('the entire 3fff::/20 documentation range is denied without excluding adjacent addresses', async () => {
  for (const ip of ['3fff::', '3fff:0::1', '3FFF:0FFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF']) {
    assert.equal(isPublicAddress(ip), false, ip);
    assert.throws(() => parseMonitorUrl(`https://[${ip}]/`), /private|reserved/);
    await assert.rejects(validateTarget('https://example.com', async () => [{ address: ip, family: 6 }]), /private|reserved/);
  }
  for (const ip of ['3ffe:ffff::1', '3fff:1000::', '3fff:ffff::1']) assert.equal(isPublicAddress(ip), true, ip);
});
test('unsafe URL protocols, credentials and local hostnames are rejected', () => {
  for (const input of ['file:///etc/passwd', 'ftp://example.com', 'https://user:password@example.com', 'http://localhost:3000', 'http://foo.local', 'http://metadata.internal', 'http://127.1', 'http://2130706433', 'http://[::ffff:127.0.0.1]']) assert.throws(() => parseMonitorUrl(input), input);
  assert.equal(parseMonitorUrl('https://example.com/health#fragment').href, 'https://example.com/health');
});
test('DNS resolving to any private address is rejected, even with a public record', async () => {
  for (const address of [{ address: '10.0.0.1', family: 4 }, { address: 'fd00::1', family: 6 }, { address: '3fff:fff::1', family: 6 }]) {
    await assert.rejects(validateTarget('https://example.com', async () => [{ address: '93.184.216.34', family: 4 }, address]), /private|reserved/);
  }
});
test('public targets expose all vetted addresses in order and preserve the first address', async () => {
  const addresses = [{ address: '2001:200::1', family: 6 }, { address: '93.184.216.34', family: 4 }];
  const target = await validateTarget('https://example.com/a', async () => addresses);
  assert.deepEqual(target.addresses, addresses);
  assert.strictEqual(target.address, target.addresses[0]);
  assert.equal(target.address.address, '2001:200::1'); assert.equal(target.url.pathname, '/a');
});
test('public IP literals expose one vetted address without DNS resolution', async () => {
  const target = await validateTarget('https://[2001:200::1]/', async () => { throw new Error('DNS must not run'); });
  assert.deepEqual(target.addresses, [{ address: '2001:200::1', family: 6 }]);
  assert.strictEqual(target.address, target.addresses[0]);
});
test('DNS failures and empty records become explicit validation errors', async () => {
  await assert.rejects(validateTarget('https://example.com', async () => { throw new Error('not found'); }), /could not be resolved/);
  await assert.rejects(validateTarget('https://example.com', async () => []), /private or reserved/);
});

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from './errors.ts';

export interface Address { address: string; family: number }
export type Resolver = (hostname: string) => Promise<Address[]>;
export const resolveAddresses: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    // Permit global unicast only. IPv4-mapped, unique-local, link-local,
    // multicast, transition mechanisms and documentation ranges are denied.
    const first = parseInt(normalized.split(':')[0] || '0', 16);
    const second = parseInt(normalized.split(':')[1] || '0', 16);
    if ((first & 0xe000) !== 0x2000 || first === 0x2002) return false;
    if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
    if (first === 0x3fff && second < 0x1000) return false;
    return !normalized.includes('%');
  }
  return false;
}

export function parseMonitorUrl(input: unknown): URL {
  if (typeof input !== 'string' || input.length > 2048) throw new ApiError(400, 'INVALID_URL', 'Enter a public HTTP or HTTPS URL.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new ApiError(400, 'INVALID_URL', 'Enter a complete URL beginning with https:// or http://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(400, 'UNSAFE_URL', 'Only HTTP/HTTPS URLs without embedded credentials are supported.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const family = isIP(hostname);
  if (family && !isPublicAddress(hostname)) throw new ApiError(400, 'PRIVATE_ADDRESS', 'Local, private and reserved addresses cannot be monitored.');
  if (!family && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|localdomain|onion|test|invalid)$/.test(hostname))) throw new ApiError(400, 'PRIVATE_ADDRESS', 'Use a public domain name, not a local or reserved host.');
  url.hash = '';
  return url;
}

export async function validateTarget(input: unknown, resolver: Resolver = resolveAddresses): Promise<{ url: URL; address: Address; addresses: Address[] }> {
  const url = parseMonitorUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(hostname);
  let addresses: Address[];
  try { addresses = family ? [{ address: hostname, family }] : await resolver(hostname); }
  catch { throw new ApiError(400, 'DNS_FAILED', 'The public hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new ApiError(400, 'PRIVATE_ADDRESS', 'The hostname resolves to a private or reserved address.');
  return { url, address: addresses[0], addresses };
}

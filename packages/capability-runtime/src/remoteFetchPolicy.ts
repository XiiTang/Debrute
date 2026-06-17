import { lookup as nodeLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface PublicRemoteHostLookupAddress {
  address: string;
  family: 4 | 6;
}

export type PublicRemoteHostLookup = (hostname: string) => Promise<PublicRemoteHostLookupAddress[]>;

export interface PublicRemoteFetchPolicyOptions {
  lookup?: PublicRemoteHostLookup | undefined;
}

export async function assertPublicHttpUrl(
  value: string,
  label: string,
  options: PublicRemoteFetchPolicyOptions = {}
): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an http(s) URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be an http(s) URL: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include URL credentials: ${value}`);
  }

  const host = canonicalHost(url.hostname);
  await assertPublicHost(host, label, value, options.lookup ?? defaultLookup);
  return url.toString();
}

export async function publicHttpRedirectUrl(
  currentUrl: string,
  location: string | null,
  label: string,
  options: PublicRemoteFetchPolicyOptions = {}
): Promise<string> {
  if (!location) {
    throw new Error(`${label} redirect response is missing a location header.`);
  }
  return assertPublicHttpUrl(new URL(location, currentUrl).toString(), label, options);
}

async function defaultLookup(hostname: string): Promise<PublicRemoteHostLookupAddress[]> {
  const addresses = await nodeLookup(hostname, { all: true, verbatim: false });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

async function assertPublicHost(
  host: string,
  label: string,
  value: string,
  lookup: PublicRemoteHostLookup
): Promise<void> {
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`${label} must not target local or private network hosts: ${value}`);
  }
  const ipKind = isIP(host);
  if (ipKind !== 0) {
    assertPublicAddress(host, label, value);
    return;
  }

  let addresses: PublicRemoteHostLookupAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error(`${label} host could not be resolved: ${value}`);
  }
  if (addresses.length === 0) {
    throw new Error(`${label} host could not be resolved: ${value}`);
  }
  for (const address of addresses) {
    assertPublicAddress(address.address, label, value);
  }
}

function assertPublicAddress(address: string, label: string, value: string): void {
  const host = canonicalHost(address);
  const ipKind = isIP(host);
  const unsafe = ipKind === 4
    ? isPrivateIpv4(host)
    : ipKind === 6
      ? isPrivateIpv6(host)
      : true;
  if (unsafe) {
    throw new Error(`${label} must not target local or private network hosts: ${value}`);
  }
}

function canonicalHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isPrivateIpv4(host: string): boolean {
  return isPrivateIpv4Parts(host.split('.').map(Number));
}

function isPrivateIpv4Parts(parts: number[]): boolean {
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const first = parts[0]!;
  const second = parts[1]!;
  return first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 169 && second === 254)
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second !== undefined && second >= 64 && second <= 127);
}

function isPrivateIpv6(host: string): boolean {
  const mappedIpv4 = ipv4MappedIpv6Address(host);
  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }
  const groups = expandedIpv6Groups(host);
  if (!groups) {
    return true;
  }
  const first = groups[0]!;
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const multicast = (first & 0xff00) === 0xff00;
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  if (allZero || loopback || multicast || uniqueLocal || linkLocal) {
    return true;
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4Parts([
      groups[6]! >> 8,
      groups[6]! & 0xff,
      groups[7]! >> 8,
      groups[7]! & 0xff
    ]);
  }
  return false;
}

function ipv4MappedIpv6Address(host: string): string | undefined {
  const prefix = '::ffff:';
  if (!host.startsWith(prefix)) {
    return undefined;
  }
  const suffix = host.slice(prefix.length);
  return isIP(suffix) === 4 ? suffix : undefined;
}

function expandedIpv6Groups(host: string): number[] | undefined {
  const parts = host.split('::');
  if (parts.length > 2) {
    return undefined;
  }
  const left = parseIpv6Side(parts[0] ?? '');
  const right = parseIpv6Side(parts[1] ?? '');
  if (!left || !right) {
    return undefined;
  }
  if (parts.length === 1) {
    return left.length === 8 ? left : undefined;
  }
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) {
    return undefined;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function parseIpv6Side(value: string): number[] | undefined {
  if (!value) {
    return [];
  }
  const groups = value.split(':');
  const result: number[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.includes('.')) {
      if (index !== groups.length - 1) {
        return undefined;
      }
      if (isIP(group) !== 4) {
        return undefined;
      }
      const ipv4 = group.split('.').map(Number);
      result.push((ipv4[0]! << 8) + ipv4[1]!);
      result.push((ipv4[2]! << 8) + ipv4[3]!);
      continue;
    }
    const parsed = Number.parseInt(group, 16);
    if (!group || !Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
      return undefined;
    }
    result.push(parsed);
  }
  return result;
}

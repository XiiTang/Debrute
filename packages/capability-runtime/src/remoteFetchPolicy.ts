import { isIP } from 'node:net';

export function assertPublicHttpUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an http(s) URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be an http(s) URL: ${value}`);
  }
  if (isLocalOrPrivateHost(url.hostname)) {
    throw new Error(`${label} must not target local or private network hosts: ${value}`);
  }
}

export function publicHttpRedirectUrl(currentUrl: string, location: string | null, label: string): string {
  if (!location) {
    throw new Error(`${label} redirect response is missing a location header.`);
  }
  const next = new URL(location, currentUrl).toString();
  assertPublicHttpUrl(next, label);
  return next;
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  const ipKind = isIP(host);
  if (ipKind === 4) {
    return isPrivateIpv4(host);
  }
  if (ipKind === 6) {
    return isPrivateIpv6(host);
  }
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  const [first, second] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second !== undefined && second >= 64 && second <= 127);
}

function isPrivateIpv6(host: string): boolean {
  return host === '::'
    || host === '::1'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || host.startsWith('fe8')
    || host.startsWith('fe9')
    || host.startsWith('fea')
    || host.startsWith('feb')
    || host.startsWith('::ffff:127.')
    || host.startsWith('::ffff:10.')
    || host.startsWith('::ffff:192.168.');
}

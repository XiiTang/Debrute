import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as nodeLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export interface PublicRemoteHostLookupAddress {
  address: string;
  family: 4 | 6;
}

export type PublicRemoteHostLookup = (hostname: string) => Promise<PublicRemoteHostLookupAddress[]>;

export interface PublicRemoteFetchPolicyOptions {
  lookup?: PublicRemoteHostLookup | undefined;
}

export interface PublicRemoteResolvedUrl {
  url: string;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface PublicRemoteHttpTransportInput {
  url: string;
  resolved: PublicRemoteResolvedUrl;
  method: string;
  headers?: HeadersInit | undefined;
  signal?: AbortSignal | undefined;
}

export type PublicRemoteHttpTransport = (input: PublicRemoteHttpTransportInput) => Promise<Response>;

export interface PublicRemoteHttpRequestInit {
  method?: string | undefined;
  headers?: HeadersInit | undefined;
  signal?: AbortSignal | null | undefined;
}

export interface PublicRemoteHttpFetchOptions extends PublicRemoteFetchPolicyOptions {
  transport?: PublicRemoteHttpTransport | undefined;
}

export async function assertPublicHttpUrl(
  value: string,
  label: string,
  options: PublicRemoteFetchPolicyOptions = {}
): Promise<string> {
  return (await resolvePublicHttpUrl(value, label, options)).url;
}

export async function resolvePublicHttpUrl(
  value: string,
  label: string,
  options: PublicRemoteFetchPolicyOptions = {}
): Promise<PublicRemoteResolvedUrl> {
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
  const address = await resolvePublicHost(host, label, value, options.lookup ?? defaultLookup);
  return {
    url: url.toString(),
    hostname: host,
    address: address.address,
    family: address.family
  };
}

export async function fetchPublicHttpUrl(
  value: string,
  label: string,
  init: PublicRemoteHttpRequestInit = {},
  options: PublicRemoteHttpFetchOptions = {}
): Promise<Response> {
  const resolved = await resolvePublicHttpUrl(value, label, options);
  const transport = options.transport ?? nodePublicRemoteHttpTransport;
  return transport({
    url: resolved.url,
    resolved,
    method: init.method ?? 'GET',
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.signal ? { signal: init.signal } : {})
  });
}

export async function publicHttpRedirectUrl(
  currentUrl: string,
  location: string | null,
  label: string,
  options: PublicRemoteFetchPolicyOptions = {}
): Promise<string> {
  return assertPublicHttpUrl(resolveHttpRedirectUrl(currentUrl, location, label), label, options);
}

export function resolveHttpRedirectUrl(currentUrl: string, location: string | null, label: string): string {
  if (!location) {
    throw new Error(`${label} redirect response is missing a location header.`);
  }
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new Error(`${label} redirect location is not a valid URL.`);
  }
}

async function defaultLookup(hostname: string): Promise<PublicRemoteHostLookupAddress[]> {
  const addresses = await nodeLookup(hostname, { all: true, verbatim: false });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

async function resolvePublicHost(
  host: string,
  label: string,
  value: string,
  lookup: PublicRemoteHostLookup
): Promise<PublicRemoteHostLookupAddress> {
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`${label} must not target local or private network hosts: ${value}`);
  }
  const ipKind = isIP(host);
  if (ipKind !== 0) {
    return publicAddress(host, label, value);
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
  const publicAddresses = addresses.map((address) => publicAddress(address.address, label, value));
  return publicAddresses[0]!;
}

function publicAddress(address: string, label: string, value: string): PublicRemoteHostLookupAddress {
  const host = canonicalHost(address);
  const ipKind = isIP(host);
  if (ipKind !== 4 && ipKind !== 6) {
    throw new Error(`${label} must not target local or private network hosts: ${value}`);
  }
  if (isUnsafeAddress(host, ipKind)) {
    throw new Error(`${label} must not target local or private network hosts: ${value}`);
  }
  return { address: host, family: ipKind };
}

function isUnsafeAddress(host: string, ipKind: 4 | 6): boolean {
  return ipKind === 4
    ? isPrivateIpv4(host)
    : isPrivateIpv6(host);
}

async function nodePublicRemoteHttpTransport(input: PublicRemoteHttpTransportInput): Promise<Response> {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  const url = new URL(input.url);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: input.method,
      headers: nodeRequestHeaders(input.headers),
      lookup: (_hostname, _options, callback) => {
        callback(null, input.resolved.address, input.resolved.family);
      },
      ...(input.signal ? { signal: input.signal } : {})
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status,
        ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
        headers: responseHeaders(incoming.headers)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function nodeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  const output: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        output.append(key, item);
      }
      continue;
    }
    output.set(key, String(value));
  }
  return output;
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

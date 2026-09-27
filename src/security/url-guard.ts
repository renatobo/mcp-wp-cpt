// src/security/url-guard.ts
//
// SSRF guard for server-side fetches of caller-supplied URLs (create_media.source_url).
// Only http/https is allowed, and every hop's hostname must resolve to public
// addresses. The validated addresses are pinned into the request through axios's
// `lookup` option, so a DNS answer that changes between validation and connect
// (DNS rebinding) cannot redirect the socket to a private address.
//
// Guarded requests set `proxy: false`, so HTTP(S)_PROXY is ignored. Through a proxy
// the pinned `lookup` would resolve the proxy host to the target address, and the
// proxy would resolve the target itself, bypassing both pinning and validation.
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { getRequestTimeoutMs } from '../config/site-manager.js';

export type LookupAddress = { address: string; family: number };
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;
export type RequestFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

export function parsePositiveIntEnv(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveMaxBytes(envValue: string | undefined = process.env.WORDPRESS_MEDIA_MAX_BYTES) {
  return parsePositiveIntEnv(envValue, DEFAULT_MAX_BYTES);
}

export function privateUrlsAllowed(envValue: string | undefined = process.env.WORDPRESS_MEDIA_ALLOW_PRIVATE_URLS) {
  return envValue?.trim().toLowerCase() === 'true';
}

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family }));
};

function ipv4ToNumber(ip: string) {
  return ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, cloud metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation (TEST-NET-1)
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation (TEST-NET-2)
  ['203.0.113.0', 24],   // documentation (TEST-NET-3)
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reserved, broadcast
];

function isBlockedIpv4(ip: string) {
  const value = ipv4ToNumber(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToNumber(base);
    return value >= start && value < start + size;
  });
}

// Expand an IPv6 address (possibly with an embedded dotted IPv4 tail) to 8 hextets.
function expandIpv6(ip: string): number[] | null {
  let address = ip.split('%')[0].toLowerCase();

  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (net.isIPv4(dotted[2]) === false) return null;
    const n = ipv4ToNumber(dotted[2]);
    address = `${dotted[1]}${(Math.floor(n / 65536)).toString(16)}:${(n % 65536).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;

  const hextets = [...head, ...Array(fill).fill('0'), ...tail].map((part) => parseInt(part, 16));
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff)
    ? hextets
    : null;
}

function embeddedIpv4(hextets: number[]) {
  const high = hextets[6];
  const low = hextets[7];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isBlockedIpv6(ip: string) {
  const h = expandIpv6(ip);
  if (!h) return true;

  const firstSixZero = h.slice(0, 6).every((x) => x === 0);
  const firstFiveZero = h.slice(0, 5).every((x) => x === 0);

  if (h.every((x) => x === 0)) return true;                            // :: unspecified
  if (firstSixZero && h[6] === 0 && h[7] === 1) return true;           // ::1 loopback
  if (firstFiveZero && h[5] === 0xffff) return isBlockedIpv4(embeddedIpv4(h)); // ::ffff:0:0/96 mapped
  if (firstSixZero) return isBlockedIpv4(embeddedIpv4(h));             // ::/96 IPv4-compatible (deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIpv4(embeddedIpv4(h));                             // 64:ff9b::/96 NAT64
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;     // 64:ff9b:1::/48 local-use NAT64
  if (h[0] === 0x2002) {
    return isBlockedIpv4(embeddedIpv4([0, 0, 0, 0, 0, 0, h[1], h[2]])); // 2002::/16 6to4
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true;                         // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true;                         // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true;                         // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true;                         // ff00::/8 multicast
  return false;
}

/** True when the IP literal is loopback, private, link-local, CGNAT, multicast, or reserved. */
export function isBlockedAddress(ip: string) {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

export type UrlGuardOptions = {
  lookup?: LookupFn;
  allowPrivate?: boolean;
};

export type ValidatedUrl = {
  url: URL;
  addresses: LookupAddress[];
};

/**
 * Validate a URL for a server-side fetch: http/https only, and the host (literal or
 * resolved) must not point at a non-public address unless allowPrivate is set.
 */
export async function validateOutboundUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('source_url must be an absolute http or https URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('source_url must be an absolute http or https URL');
  }

  if (url.username || url.password) {
    throw new Error('source_url must not contain credentials');
  }

  const allowPrivate = options.allowPrivate ?? privateUrlsAllowed();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(hostname)) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new Error(blockedMessage(url.host, hostname));
    }
    return { url, addresses: [{ address: hostname, family: net.isIP(hostname) }] };
  }

  const lookup = options.lookup ?? defaultLookup;
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (error: any) {
    throw new Error(`Unable to resolve host '${hostname}': ${error?.message || String(error)}`);
  }

  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host '${hostname}'`);
  }

  if (!allowPrivate) {
    const blocked = addresses.find(({ address }) => isBlockedAddress(address));
    if (blocked) {
      throw new Error(blockedMessage(hostname, blocked.address));
    }
  }

  return { url, addresses };
}

function blockedMessage(host: string, address: string) {
  return `source_url host '${host}' resolves to non-public address ${address}. `
    + 'Fetching loopback, private, link-local, or reserved addresses is blocked. '
    + 'Set WORDPRESS_MEDIA_ALLOW_PRIVATE_URLS=true to allow it.';
}

function pinnedLookup(addresses: LookupAddress[]) {
  return async (): Promise<LookupAddress[]> => addresses;
}

export type GuardedFetchOptions = UrlGuardOptions & {
  request?: RequestFn;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
};

/**
 * GET a caller-supplied URL as an ArrayBuffer, validating every redirect hop and
 * pinning each connection to the addresses that passed validation.
 */
export async function guardedFetch(rawUrl: string, options: GuardedFetchOptions = {}): Promise<AxiosResponse<ArrayBuffer>> {
  const request: RequestFn = options.request ?? ((config) => axios.request(config));
  const maxBytes = options.maxBytes ?? resolveMaxBytes();
  const timeoutMs = options.timeoutMs ?? getRequestTimeoutMs();
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url, addresses } = await validateOutboundUrl(currentUrl, options);

    const response = await request({
      method: 'GET',
      url: url.toString(),
      responseType: 'arraybuffer',
      headers: options.headers,
      maxRedirects: 0,
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      lookup: pinnedLookup(addresses),
      proxy: false,
      validateStatus: (status) => status >= 200 && status < 400
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location;
      if (typeof location !== 'string' || !location) {
        throw new Error(`source_url returned HTTP ${response.status} without a Location header`);
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    return response as AxiosResponse<ArrayBuffer>;
  }

  throw new Error(`source_url exceeded the maximum of ${maxRedirects} redirects`);
}

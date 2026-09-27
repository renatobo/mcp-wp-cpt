import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { SiteManager, getRequestTimeoutMs } from '../../src/config/site-manager.js';

const ENV_KEYS = ['WORDPRESS_API_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_PASSWORD', 'WORDPRESS_REQUEST_TIMEOUT_MS'];
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = {};
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
  process.env.WORDPRESS_API_URL = 'https://site.test';
  process.env.WORDPRESS_USERNAME = 'admin';
  process.env.WORDPRESS_PASSWORD = 'pw';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (envBackup[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envBackup[key];
    }
  }
});

// Real axios instance with a capture adapter: no network, but real URL building.
function stubAxiosCreate() {
  const originalCreate = axios.create.bind(axios);
  const seen: string[] = [];
  vi.spyOn(axios, 'create').mockImplementation((config) =>
    originalCreate({
      ...config,
      adapter: async (requestConfig) => {
        seen.push(axios.getUri(requestConfig));
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config: requestConfig };
      }
    })
  );
  return seen;
}

describe('SiteManager client policy', () => {
  it('creates clients that refuse absolute URLs and have a default timeout', async () => {
    stubAxiosCreate();
    const client = await new SiteManager().getClient();

    expect(client.defaults.allowAbsoluteUrls).toBe(false);
    expect(client.defaults.timeout).toBe(30000);
    expect(client.defaults.baseURL).toBe('https://site.test/wp-json/wp/v2/');
  });

  it('keeps an absolute endpoint on the site host', async () => {
    const seen = stubAxiosCreate();
    const client = await new SiteManager().getClient();
    await client.request({ method: 'GET', url: 'https://attacker.example/c' });

    const last = seen[seen.length - 1];
    expect(last.startsWith('https://site.test/wp-json/wp/v2/')).toBe(true);
  });

  it('honours WORDPRESS_REQUEST_TIMEOUT_MS', async () => {
    process.env.WORDPRESS_REQUEST_TIMEOUT_MS = '5000';
    stubAxiosCreate();
    const client = await new SiteManager().getClient();
    expect(client.defaults.timeout).toBe(5000);
  });
});

describe('getRequestTimeoutMs', () => {
  it('parses positive integers and falls back to 30000 otherwise', () => {
    expect(getRequestTimeoutMs(undefined)).toBe(30000);
    expect(getRequestTimeoutMs('')).toBe(30000);
    expect(getRequestTimeoutMs('1500')).toBe(1500);
    expect(getRequestTimeoutMs(' 1500 ')).toBe(1500);
    expect(getRequestTimeoutMs('0')).toBe(30000);
    expect(getRequestTimeoutMs('-5')).toBe(30000);
    expect(getRequestTimeoutMs('1.5')).toBe(30000);
    expect(getRequestTimeoutMs('abc')).toBe(30000);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { SiteManager, siteManager } from '../../src/config/site-manager.js';
import { assertRelativeEndpoint, makeWordPressRequest, shouldRetryWithFallback } from '../../src/wordpress.js';
import { buildManifestIssue } from '../../src/adapters/manifest-loader.js';

const ENV_KEYS = ['WORDPRESS_API_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_PASSWORD'];
let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = {};
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
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

function axiosError(status: number, data: Record<string, unknown> = {}): AxiosError {
  const config = { headers: new AxiosHeaders() } as any;
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, undefined, {
    status,
    statusText: String(status),
    headers: {},
    config,
    data
  });
}

function stubClient(handler: (config: any) => any) {
  return {
    defaults: { baseURL: 'https://site.test/wp-json/wp/v2/', headers: {} },
    request: vi.fn(async (config: any) => ({ status: 200, data: handler(config) }))
  } as any;
}

describe('SiteManager namespace probe failures', () => {
  it('rethrows the AxiosError with its status and does not cache the failed client', async () => {
    const originalCreate = axios.create.bind(axios);
    let probes = 0;
    vi.spyOn(axios, 'create').mockImplementation((config) =>
      originalCreate({
        ...config,
        adapter: async (requestConfig) => {
          probes += 1;
          throw new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', requestConfig as any, undefined, {
            status: 404,
            statusText: 'Not Found',
            headers: {},
            config: requestConfig as any,
            data: { code: 'rest_no_route' }
          });
        }
      })
    );

    const manager = new SiteManager();
    const failure = await manager.getClient(undefined, 'eventonapify/v1').catch((error) => error);
    expect(axios.isAxiosError(failure)).toBe(true);
    expect(failure.response.status).toBe(404);
    expect(failure.message).toMatch(/Failed to connect to site 'default' namespace 'eventonapify\/v1'/);

    await manager.getClient(undefined, 'eventonapify/v1').catch(() => undefined);
    expect(probes).toBe(2);
  });

  it('classifies a probe 404 as a missing manifest', async () => {
    const issue = buildManifestIssue(
      { provider: 'eventon-apify', namespace: 'eventonapify/v1', endpoint: 'mcp-schema' },
      axiosError(404, { code: 'rest_no_route' })
    );
    expect(issue.status).toBe('missing');
  });

  it('classifies a disabled APIfy manifest as a distinct disabled issue', () => {
    const issue = buildManifestIssue(
      { provider: 'eventon-apify', namespace: 'eventonapify/v1', endpoint: 'mcp-schema' },
      axiosError(403, { code: 'eventon_apify_disabled', message: 'The EventON APIfy endpoint is disabled.' })
    );
    expect(issue.status).toBe('disabled');
    expect(issue.message).toMatch(/API is disabled/);

    const forbidden = buildManifestIssue(
      { provider: 'eventon-apify', namespace: 'eventonapify/v1', endpoint: 'mcp-schema' },
      axiosError(403, { code: 'rest_forbidden' })
    );
    expect(forbidden.status).toBe('error');
  });
});

describe('makeWordPressRequest fallback', () => {
  it('runs the 404 fallback when the plugin namespace probe fails', async () => {
    const wpClient = stubClient((config) => [{ id: 1, url: config.url, params: config.params }]);
    vi.spyOn(siteManager, 'getClient').mockImplementation(async (_siteId?: string, namespace?: string) => {
      if (namespace === 'eventonapify/v1') {
        throw axiosError(404, { code: 'rest_no_route' });
      }
      return wpClient;
    });

    const response = await makeWordPressRequest('GET', 'events', { starts_on_or_after: '2026-01-01' }, {
      siteId: 'default',
      namespace: 'eventonapify/v1',
      retry404With: { endpoint: 'ajde_events', namespace: 'wp/v2', data: { after: '2026-01-01' } }
    });

    expect(response).toEqual([{ id: 1, url: 'ajde_events', params: { after: '2026-01-01' } }]);
  });

  it('retries a 403 only for listed WordPress error codes', async () => {
    const fallback = { endpoint: 'ajde_events', namespace: 'wp/v2', on403Codes: ['eventon_apify_disabled'] };
    expect(shouldRetryWithFallback(axiosError(403, { code: 'eventon_apify_disabled' }), fallback)).toBe(true);
    expect(shouldRetryWithFallback(axiosError(403, { code: 'rest_forbidden' }), fallback)).toBe(false);
    expect(shouldRetryWithFallback(axiosError(403, { code: 'eventon_apify_disabled' }), { endpoint: 'x' })).toBe(false);
    expect(shouldRetryWithFallback(axiosError(404), { endpoint: 'x' })).toBe(true);
    expect(shouldRetryWithFallback(axiosError(500), fallback)).toBe(false);
  });
});

describe('assertRelativeEndpoint', () => {
  it('rejects unresolved endpoint template braces', () => {
    expect(() => assertRelativeEndpoint('events/{event_id}/rsvps')).toThrow(/unsafe endpoint/);
    expect(() => assertRelativeEndpoint('events/%7Bid%7D')).toThrow(/unsafe endpoint/);
    expect(() => assertRelativeEndpoint('events/12/rsvps')).not.toThrow();
  });
});

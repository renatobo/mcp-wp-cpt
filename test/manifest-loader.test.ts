import test from 'node:test';
import assert from 'node:assert/strict';
import { clearManifestCache, loadSiteManifests } from '../src/adapters/manifest-loader.js';

test('loadSiteManifests caches per site and refreshes on demand', async () => {
  clearManifestCache();

  let requestCount = 0;
  const request = async (_method: string, _endpoint: string, _data: unknown, options?: { siteId?: string }) => {
    requestCount += 1;

    return {
      schema_version: '1.0.0',
      provider: 'eventon-apify',
      content_types: {
        ajde_events: {
          slug: 'ajde_events',
          preferred_endpoint: 'wp/v2/ajde_events',
          preferred_write_mode: 'fields'
        }
      },
      site_marker: options?.siteId
    };
  };

  const first = await loadSiteManifests('site-a', false, {
    request: request as any,
    resolveSiteId: (siteId) => siteId || 'site-a',
    now: () => 1_000
  });
  const second = await loadSiteManifests('site-a', false, {
    request: request as any,
    resolveSiteId: (siteId) => siteId || 'site-a',
    now: () => 2_000
  });
  const third = await loadSiteManifests('site-b', false, {
    request: request as any,
    resolveSiteId: (siteId) => siteId || 'site-b',
    now: () => 3_000
  });
  const refreshed = await loadSiteManifests('site-a', true, {
    request: request as any,
    resolveSiteId: (siteId) => siteId || 'site-a',
    now: () => 4_000
  });

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(third.cacheHit, false);
  assert.equal(refreshed.cacheHit, false);
  assert.equal(requestCount, 3);
  assert.equal(first.manifests[0]?.contentTypes[0]?.slug, 'ajde_events');
  assert.equal(third.siteId, 'site-b');
});

test('loadSiteManifests reports missing and incompatible manifests explicitly', async () => {
  clearManifestCache();

  const missing = await loadSiteManifests('site-a', true, {
    request: async () => {
      throw {
        isAxiosError: true,
        response: { status: 404 }
      };
    },
    resolveSiteId: (siteId) => siteId || 'site-a'
  });

  const incompatible = await loadSiteManifests('site-b', true, {
    request: async () => ({
      provider: 'eventon-apify',
      schema_version: '2.0.0',
      content_types: {}
    }),
    resolveSiteId: (siteId) => siteId || 'site-b'
  });

  assert.equal(missing.issues[0]?.status, 'missing');
  assert.equal(incompatible.issues[0]?.status, 'incompatible');
});

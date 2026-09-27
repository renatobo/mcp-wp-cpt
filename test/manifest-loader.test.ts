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

test('loadSiteManifests normalizes type arrays and also_accepts on field definitions', async () => {
  clearManifestCache();

  const result = await loadSiteManifests('site-c', true, {
    request: async () => ({
      schema_version: '1.0.0',
      provider: 'eventon-apify',
      content_types: [{
        slug: 'ajde_events',
        preferred_endpoint: 'eventonapify/v1/events',
        fields: [
          { name: 'location', type: 'object', shape: [{ name: 'lat', type: ['string', 'number'] }] },
          { name: 'tags', type: 'array', also_accepts: ['comma_separated_string'], items: { type: 'string' } }
        ]
      }]
    }),
    resolveSiteId: (siteId) => siteId || 'site-c'
  });

  const [location, tags] = result.manifests[0].contentTypes[0].fields!;
  assert.equal(location.shape?.[0].type, 'string');
  assert.deepEqual(location.shape?.[0].types, ['string', 'number']);
  assert.deepEqual(tags.also_accepts, ['comma_separated_string']);
  // A single string type is not repeated as a one-entry `types` list.
  assert.equal(location.types, undefined);
  assert.equal(tags.types, undefined);
});

test('loadSiteManifests reports a disabled APIfy API distinctly', async () => {
  clearManifestCache();

  const disabled = await loadSiteManifests('site-d', true, {
    request: async () => {
      throw {
        isAxiosError: true,
        response: { status: 403, data: { code: 'eventon_apify_capability_disabled' } }
      };
    },
    resolveSiteId: (siteId) => siteId || 'site-d'
  });

  assert.equal(disabled.issues[0]?.status, 'disabled');
  assert.match(disabled.issues[0]?.message, /API is disabled/);
});

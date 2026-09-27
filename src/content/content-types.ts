import { siteManager } from '../config/site-manager.js';
import { makeWordPressRequest, logToFile } from '../wordpress.js';
import { listResolvedContentTypeContracts } from '../adapters/registry.js';
import { PROVIDER_ROUTED_CONTENT_TYPES, assertValidContentTypeIdentifier, getContentEndpoint } from './utils.js';

export { assertValidContentTypeIdentifier } from './utils.js';

const DEFAULT_CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const parsedCacheDuration = parseInt(process.env.WORDPRESS_CACHE_DURATION || '', 10);
const CACHE_DURATION_MS = Number.isFinite(parsedCacheDuration) && parsedCacheDuration >= 0
  ? parsedCacheDuration
  : DEFAULT_CACHE_DURATION_MS;
// Unknown names are remembered briefly so repeated misses (e.g. a slug fan-out
// across types) do not each force a /types refetch.
const NEGATIVE_CACHE_DURATION_MS = 60 * 1000;
// rest_base comes from the site; keep it to plain relative path characters.
const REST_BASE_PATTERN = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i;

export interface ResolvedContentType {
  slug: string;
  restBase: string;
  source: 'types' | 'contract' | 'fallback';
}

export interface ContentTypeResolverDependencies {
  request?: typeof makeWordPressRequest;
  listContracts?: (siteId?: string) => Promise<Array<{ contract: { slug: string } }>>;
  resolveSiteId?: (siteId?: string) => string;
  now?: () => number;
}

const typesCache = new Map<string, { timestamp: number; data: Record<string, any> }>();
// One in-flight /types fetch per site, shared by concurrent callers.
const inFlightTypes = new Map<string, Promise<Record<string, any>>>();
// siteId -> (content type -> time it was confirmed unknown)
const unknownTypesCache = new Map<string, Map<string, number>>();

function fetchTypes(
  siteId: string,
  dependencies: ContentTypeResolverDependencies
): Promise<Record<string, any>> {
  const pending = inFlightTypes.get(siteId);
  if (pending) return pending;

  const request = dependencies.request || makeWordPressRequest;
  const promise = (async () => {
    logToFile(`Fetching content types for site ${siteId}`);
    const response = await request('GET', 'types', undefined, { siteId });
    const data = response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, any>)
      : {};
    typesCache.set(siteId, { timestamp: (dependencies.now || Date.now)(), data });
    return data;
  })();

  inFlightTypes.set(siteId, promise);
  promise.then(
    () => inFlightTypes.delete(siteId),
    () => inFlightTypes.delete(siteId)
  );
  return promise;
}

async function getPostTypes(
  siteId: string,
  forceRefresh: boolean,
  dependencies: ContentTypeResolverDependencies
): Promise<Record<string, any>> {
  const now = (dependencies.now || Date.now)();
  const cached = typesCache.get(siteId);

  if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
    return cached.data;
  }

  if (forceRefresh) {
    unknownTypesCache.delete(siteId);
  }

  return fetchTypes(siteId, dependencies);
}

/**
 * Raw /wp/v2/types map for a site, from the shared per-site cache.
 * forceRefresh refetches (and drops remembered unknown names).
 */
export async function getSiteTypes(
  siteId?: string,
  forceRefresh = false,
  dependencies: ContentTypeResolverDependencies = {}
): Promise<Record<string, any>> {
  const resolveSiteId = dependencies.resolveSiteId || ((requested?: string) => siteManager.resolveSiteId(requested));
  return getPostTypes(resolveSiteId(siteId), forceRefresh, dependencies);
}

function isRecentlyUnknown(siteId: string, contentType: string, now: number): boolean {
  const seenAt = unknownTypesCache.get(siteId)?.get(contentType);
  return seenAt !== undefined && (now - seenAt) < NEGATIVE_CACHE_DURATION_MS;
}

function rememberUnknown(siteId: string, contentType: string, now: number) {
  let entries = unknownTypesCache.get(siteId);
  if (!entries) {
    entries = new Map();
    unknownTypesCache.set(siteId, entries);
  }
  entries.set(contentType, now);
}

function findInTypes(input: string, types: Record<string, any>): ResolvedContentType | null {
  for (const [slug, info] of Object.entries(types)) {
    const restBase = typeof info?.rest_base === 'string' && info.rest_base ? info.rest_base : slug;
    if (slug === input || restBase === input) {
      if (!REST_BASE_PATTERN.test(restBase)) {
        throw new Error(`Content type "${slug}" has an unsupported rest_base "${restBase}"`);
      }
      return { slug, restBase, source: 'types' };
    }
  }
  return null;
}

/**
 * Resolve a content type identifier (slug or rest_base) against the site's
 * /wp/v2/types response, plus contract-backed slugs from plugin manifests
 * (e.g. EventON ajde_events, which may not be exposed in /types).
 *
 * Hard-errors on unknown types, matching the taxonomy resolver. If /types
 * itself cannot be fetched, falls back to the validated slug so reads keep
 * working on sites that restrict that endpoint. Provider-routed types (see
 * PROVIDER_ROUTED_CONTENT_TYPES) also fall back to their slug when neither
 * /types nor a contract knows them.
 */
export async function resolveContentType(
  contentType: string,
  siteId?: string,
  dependencies: ContentTypeResolverDependencies = {},
  options: { forceRefresh?: boolean } = {}
): Promise<ResolvedContentType> {
  assertValidContentTypeIdentifier(contentType);

  const resolveSiteId = dependencies.resolveSiteId || ((requested?: string) => siteManager.resolveSiteId(requested));
  const listContracts = dependencies.listContracts || ((requested?: string) => listResolvedContentTypeContracts(requested));
  const resolvedSiteId = resolveSiteId(siteId);

  let types: Record<string, any>;
  try {
    types = await getPostTypes(resolvedSiteId, options.forceRefresh === true, dependencies);
  } catch (error: any) {
    logToFile(
      `Could not fetch content types for site ${resolvedSiteId} (${error?.message}); using "${contentType}" unverified`,
      'error'
    );
    return { slug: contentType, restBase: getContentEndpoint(contentType), source: 'fallback' };
  }

  const match = findInTypes(contentType, types);
  if (match) return match;

  const contractSlugs = await listContractSlugs(listContracts, resolvedSiteId);
  if (contractSlugs.includes(contentType)) {
    return { slug: contentType, restBase: getContentEndpoint(contentType), source: 'contract' };
  }

  // Provider-routed types (EventON ajde_events) may be missing from /types:
  // EventON 5.x registers them with show_in_rest=true, but older or filtered
  // installs do not. Keep them resolvable when the manifest is unavailable;
  // reads route by name with a wp/v2 fallback.
  if (PROVIDER_ROUTED_CONTENT_TYPES.has(contentType)) {
    return { slug: contentType, restBase: contentType, source: 'fallback' };
  }

  // Refresh once in case the type was registered after the cache was filled,
  // unless this name was confirmed unknown moments ago.
  let fresh = types;
  if (!isRecentlyUnknown(resolvedSiteId, contentType, (dependencies.now || Date.now)())) {
    try {
      fresh = await getPostTypes(resolvedSiteId, true, dependencies);
    } catch (error: any) {
      logToFile(`Could not refresh content types for site ${resolvedSiteId}: ${error?.message}`, 'error');
    }

    const freshMatch = findInTypes(contentType, fresh);
    if (freshMatch) return freshMatch;

    rememberUnknown(resolvedSiteId, contentType, (dependencies.now || Date.now)());
  }

  const available = [
    ...Object.entries(fresh).map(([slug, info]) =>
      info?.rest_base && info.rest_base !== slug ? `${slug} (rest_base: ${info.rest_base})` : slug
    ),
    ...contractSlugs.filter((slug) => !(slug in fresh))
  ].join(', ');
  throw new Error(`Unknown content type "${contentType}": not found in /wp/v2/types or plugin contracts. Available: ${available}`);
}

export async function resolveContentEndpoint(
  contentType: string,
  siteId?: string,
  dependencies: ContentTypeResolverDependencies = {}
): Promise<string> {
  return (await resolveContentType(contentType, siteId, dependencies)).restBase;
}

export function clearContentTypeCache(siteId?: string) {
  if (siteId) {
    typesCache.delete(siteId);
    unknownTypesCache.delete(siteId);
    return;
  }

  typesCache.clear();
  unknownTypesCache.clear();
}

async function listContractSlugs(
  listContracts: NonNullable<ContentTypeResolverDependencies['listContracts']>,
  siteId: string
): Promise<string[]> {
  try {
    return (await listContracts(siteId)).map((entry) => entry.contract.slug);
  } catch (error: any) {
    logToFile(`Could not load content type contracts for site ${siteId}: ${error?.message}`, 'error');
    return [];
  }
}

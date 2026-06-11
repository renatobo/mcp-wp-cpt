import axios from 'axios';
import { siteManager } from '../config/site-manager.js';
import { makeWordPressRequest, logToFile } from '../wordpress.js';
import {
  ContentTypeContract,
  ContentTypeFieldDefinition,
  ManifestCompatibilityIssue,
  ManifestLoadResult,
  ProviderManifest
} from './types.js';

const CACHE_DURATION_MS = 5 * 60 * 1000;

interface ManifestDiscoverySource {
  provider: string;
  namespace: string;
  endpoint: string;
}

export interface ManifestLoaderDependencies {
  request?: typeof makeWordPressRequest;
  resolveSiteId?: (siteId?: string) => string;
  now?: () => number;
}

const DISCOVERY_SOURCES: ManifestDiscoverySource[] = [
  {
    provider: 'eventon-apify',
    namespace: 'eventonapify/v1',
    endpoint: 'mcp-schema'
  }
];

const manifestCache = new Map<string, { timestamp: number; result: ManifestLoadResult }>();

export async function loadSiteManifests(
  siteId?: string,
  refreshCache = false,
  dependencies: ManifestLoaderDependencies = {}
): Promise<ManifestLoadResult> {
  const resolveSiteId = dependencies.resolveSiteId || ((requestedSiteId?: string) => siteManager.resolveSiteId(requestedSiteId));
  const request = dependencies.request || makeWordPressRequest;
  const now = dependencies.now || Date.now;
  const resolvedSiteId = resolveSiteId(siteId);
  const cacheEntry = manifestCache.get(resolvedSiteId);
  const nowValue = now();

  if (!refreshCache && cacheEntry && (nowValue - cacheEntry.timestamp) < CACHE_DURATION_MS) {
    return {
      ...cacheEntry.result,
      cacheHit: true
    };
  }

  const manifests: ProviderManifest[] = [];
  const issues: ManifestCompatibilityIssue[] = [];

  for (const source of DISCOVERY_SOURCES) {
    try {
      logToFile(`Loading manifest from ${source.namespace}/${source.endpoint} for site ${resolvedSiteId}`);
      const response = await request('GET', source.endpoint, undefined, {
        siteId: resolvedSiteId,
        namespace: source.namespace
      });

      const parsedManifest = parseManifestResponse(source, response);
      manifests.push(parsedManifest);
    } catch (error: any) {
      issues.push(buildManifestIssue(source, error));
    }
  }

  const result: ManifestLoadResult = {
    siteId: resolvedSiteId,
    manifests,
    issues,
    fetchedAt: nowValue,
    cacheHit: false
  };

  manifestCache.set(resolvedSiteId, {
    timestamp: nowValue,
    result
  });

  return result;
}

export function clearManifestCache(siteId?: string) {
  if (siteId) {
    manifestCache.delete(siteManager.resolveSiteId(siteId));
    return;
  }

  manifestCache.clear();
}

function parseManifestResponse(source: ManifestDiscoverySource, response: unknown): ProviderManifest {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`Manifest from ${source.provider} is not a JSON object`);
  }

  const raw = response as Record<string, unknown>;
  const schemaVersion = typeof raw.schema_version === 'string' ? raw.schema_version : undefined;
  const provider = typeof raw.provider === 'string' ? raw.provider : source.provider;
  const providerVersion = typeof raw.provider_version === 'string' ? raw.provider_version : undefined;

  if (!schemaVersion || !isSupportedSchemaVersion(schemaVersion)) {
    throw new Error(`Manifest schema_version is missing or unsupported: ${String(raw.schema_version ?? 'undefined')}`);
  }

  const contentTypes = normalizeContentTypes(raw);
  if (contentTypes.length === 0) {
    throw new Error('Manifest does not define any content types');
  }

  return {
    provider,
    provider_version: providerVersion,
    schema_version: schemaVersion,
    namespace: source.namespace,
    endpoint: source.endpoint,
    source: `${source.namespace}/${source.endpoint}`,
    contentTypes,
    raw
  };
}

function normalizeContentTypes(raw: Record<string, unknown>): ContentTypeContract[] {
  const value = raw.content_types ?? raw.contentTypes;

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeContentTypeContract(entry))
      .filter((entry): entry is ContentTypeContract => Boolean(entry));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([slug, entry]) => normalizeContentTypeContract(entry, slug))
      .filter((entry): entry is ContentTypeContract => Boolean(entry));
  }

  return [];
}

function normalizeContentTypeContract(entry: unknown, slugOverride?: string): ContentTypeContract | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const raw = entry as Record<string, unknown>;
  const slug = coerceString(raw.slug) || coerceString(raw.content_type) || slugOverride;

  if (!slug) {
    return null;
  }

  return {
    ...raw,
    slug,
    label: coerceString(raw.label) || coerceString(raw.name),
    description: coerceString(raw.description),
    preferred_endpoint:
      coerceString(raw.preferred_endpoint) ||
      coerceString(raw.rest_endpoint) ||
      coerceString(raw.endpoint),
    preferred_write_mode:
      coerceString(raw.preferred_write_mode) ||
      coerceString(raw.write_mode) ||
      'fields',
    supported_operations: normalizeStringArray(raw.supported_operations ?? raw.operations),
    parent_context: normalizeObject(raw.parent_context),
    fields: normalizeFields(raw.fields),
    validation_rules: normalizeObject(raw.validation_rules ?? raw.validation),
    examples: normalizeObject(raw.examples)
  };
}

function normalizeFields(value: unknown): ContentTypeFieldDefinition[] | undefined {
  const fields = normalizeFieldCollection(value);
  return fields.length > 0 ? fields : undefined;
}

function buildManifestIssue(source: ManifestDiscoverySource, error: any): ManifestCompatibilityIssue {
  if (axios.isAxiosError(error) && error.response?.status === 404) {
    return {
      source: `${source.namespace}/${source.endpoint}`,
      provider: source.provider,
      status: 'missing',
      message: `Manifest endpoint ${source.namespace}/${source.endpoint} is not available on this site`
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown manifest loading error';

  return {
    source: `${source.namespace}/${source.endpoint}`,
    provider: source.provider,
    status: message.includes('schema_version') || message.includes('content types') ? 'incompatible' : 'error',
    message
  };
}

function isSupportedSchemaVersion(schemaVersion: string): boolean {
  return /^1(\.|$)/.test(schemaVersion);
}

function normalizeObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => (typeof entry === 'string' ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === 'string') {
    return [value];
  }

  return undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeFieldCollection(value: unknown): ContentTypeFieldDefinition[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeFieldDefinition(entry))
      .filter((entry): entry is ContentTypeFieldDefinition => Boolean(entry));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, entry]) => normalizeFieldDefinition(entry, name))
      .filter((entry): entry is ContentTypeFieldDefinition => Boolean(entry));
  }

  return [];
}

function normalizeFieldDefinition(
  value: unknown,
  nameOverride?: string
): ContentTypeFieldDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const name = coerceString(raw.name) || coerceString(raw.slug) || coerceString(raw.key) || nameOverride;
  if (!name) {
    return null;
  }

  const shape = normalizeFieldCollection(raw.shape ?? raw.properties ?? raw.fields);
  const items = normalizeArrayItemDefinition(raw.items);

  return {
    ...raw,
    name,
    label: coerceString(raw.label) || coerceString(raw.name),
    description: coerceString(raw.description),
    type: coerceString(raw.type),
    required: typeof raw.required === 'boolean' ? raw.required : undefined,
    required_on: normalizeStringArray(raw.required_on),
    write_key:
      coerceString(raw.write_key) ||
      coerceString(raw.target) ||
      coerceString(raw.rest_field),
    aliases: normalizeStringArray(raw.aliases),
    operations: normalizeStringArray(raw.operations),
    enum: Array.isArray(raw.enum) ? raw.enum : undefined,
    coerce:
      typeof raw.coerce === 'string' || (raw.coerce && typeof raw.coerce === 'object' && !Array.isArray(raw.coerce))
        ? (raw.coerce as string | Record<string, unknown>)
        : undefined,
    shape: shape.length > 0 ? shape : undefined,
    items
  };
}

function normalizeArrayItemDefinition(value: unknown): ContentTypeFieldDefinition | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeFieldDefinition(value, 'item');
  return normalized || undefined;
}

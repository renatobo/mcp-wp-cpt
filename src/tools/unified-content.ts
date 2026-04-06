// src/tools/unified-content.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeWordPressRequest, logToFile } from '../wordpress.js';
import { z } from 'zod';
import { siteManager } from '../config/site-manager.js';
import { listResolvedContentTypeContracts, resolveContentTypeContract } from '../adapters/registry.js';
import { loadSiteManifests } from '../adapters/manifest-loader.js';
import { describeContractExecution } from '../adapters/interpreter.js';
import { formatContractError, prepareContentWriteRequest } from '../content/write-preparation.js';
import { getContentEndpoint } from '../content/utils.js';
import { prepareGetContentRequest, prepareListContentRequest } from '../content/read-preparation.js';
import { ContractCompatibilityError, ContractValidationError } from '../adapters/types.js';

// Cache for post types to reduce API calls
const postTypesCache = new Map<string, { value: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const rankMathActiveCache = new Map<string, { value: boolean; timestamp: number }>();

// Helper function to get all post types with caching
async function getPostTypes(forceRefresh = false, siteId?: string) {
  const now = Date.now();
  const resolvedSiteId = siteManager.resolveSiteId(siteId);
  const cacheEntry = postTypesCache.get(resolvedSiteId);

  if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < CACHE_DURATION) {
    logToFile('Using cached post types');
    return cacheEntry.value;
  }

  try {
    logToFile('Fetching post types from API');
    const response = await makeWordPressRequest('GET', 'types', undefined, { siteId: resolvedSiteId });
    postTypesCache.set(resolvedSiteId, {
      value: response,
      timestamp: now
    });
    return response;
  } catch (error: any) {
    logToFile(`Error fetching post types: ${error.message}`);
    throw error;
  }
}

async function isRankMathActive(forceRefresh = false, siteId?: string): Promise<boolean> {
  const now = Date.now();
  const resolvedSiteId = siteManager.resolveSiteId(siteId);
  const cacheEntry = rankMathActiveCache.get(resolvedSiteId);

  if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < CACHE_DURATION) {
    return cacheEntry.value;
  }

  try {
    const response = await makeWordPressRequest('GET', 'plugins', { status: 'active' }, { siteId: resolvedSiteId });
    const plugins = Array.isArray(response) ? response : [];

    const active = plugins.some((plugin: any) => {
      const pluginFile = typeof plugin?.plugin === 'string' ? plugin.plugin.toLowerCase() : '';
      const pluginName = typeof plugin?.name === 'string' ? plugin.name.toLowerCase() : '';
      const pluginTextDomain = typeof plugin?.textdomain === 'string' ? plugin.textdomain.toLowerCase() : '';

      return (
        pluginFile.includes('seo-by-rank-math') ||
        pluginFile.includes('rank-math') ||
        pluginName.includes('rank math') ||
        pluginTextDomain === 'rank-math'
      );
    });

    rankMathActiveCache.set(resolvedSiteId, { value: active, timestamp: now });
    return active;
  } catch (error: any) {
    // If plugin visibility is unavailable (permissions/endpoints), fail closed and skip Rank Math sync.
    logToFile(`Rank Math plugin status check failed; skipping sync: ${error.message}`);
    rankMathActiveCache.set(resolvedSiteId, { value: false, timestamp: now });
    return false;
  }
}

// Helper function to parse URL and extract slug and potential post type hints
function parseUrl(url: string): { slug: string; pathHints: string[] } {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Remove trailing slash and split path
    const pathParts = pathname.replace(/\/$/, '').split('/').filter(Boolean);
    
    // The slug is typically the last part of the URL
    const slug = pathParts[pathParts.length - 1] || '';
    
    // Path hints can help identify the post type
    const pathHints = pathParts.slice(0, -1);
    
    return { slug, pathHints };
  } catch (error) {
    logToFile(`Error parsing URL ${url}: ${error}`);
    return { slug: '', pathHints: [] };
  }
}

// Helper function to find content across multiple post types
async function findContentAcrossTypes(slug: string, contentTypes?: string[], siteId?: string) {
  const typesToSearch = contentTypes || [];
  
  // If no specific content types provided, get all available types
  if (typesToSearch.length === 0) {
    const allTypes = await getPostTypes(false, siteId);
    typesToSearch.push(...Object.keys(allTypes).filter(type => 
      type !== 'attachment' && type !== 'wp_block'
    ));
  }
  
  logToFile(`Searching for slug "${slug}" across content types: ${typesToSearch.join(', ')}`);
  
  // Search each content type for the slug
  for (const contentType of typesToSearch) {
    try {
      const endpoint = getContentEndpoint(contentType);
      
      const response = await makeWordPressRequest('GET', endpoint, {
        slug: slug,
        per_page: 1
      }, { siteId });
      
      if (Array.isArray(response) && response.length > 0) {
        logToFile(`Found content with slug "${slug}" in content type "${contentType}"`);
        return { content: response[0], contentType };
      }
    } catch (error) {
      logToFile(`Error searching ${contentType}: ${error}`);
    }
  }
  
  return null;
}

// Schema definitions
const listContentSchema = z.object({
  content_type: z.string().describe("The content type slug (e.g., 'post', 'page', 'product', 'documentation')"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  event_id: z.union([z.number(), z.string()]).optional().describe("Parent event ID for contract-backed nested content types such as 'event_rsvps'"),
  page: z.number().optional().describe("Page number (default 1)"),
  per_page: z.number().min(1).max(100).optional().describe("Items per page (default 10, max 100)"),
  search: z.string().optional().describe("Search term for content title or body"),
  rsvp: z.enum(['all', 'yes', 'no', 'maybe']).optional().describe("RSVP filter for contract-backed attendee content types such as 'event_rsvps'"),
  slug: z.string().optional().describe("Limit result to content with a specific slug"),
  status: z.string().optional().describe("Content status (publish, draft, etc.)"),
  author: z.union([z.number(), z.array(z.number())]).optional().describe("Author ID or array of IDs"),
  categories: z.union([z.number(), z.array(z.number())]).optional().describe("Category ID or array of IDs (for posts)"),
  tags: z.union([z.number(), z.array(z.number())]).optional().describe("Tag ID or array of IDs (for posts)"),
  parent: z.number().optional().describe("Parent ID (for hierarchical content like pages)"),
  orderby: z.string().optional().describe("Sort content by parameter"),
  order: z.enum(['asc', 'desc']).optional().describe("Order sort attribute"),
  after: z.string().optional().describe("ISO8601 date string to get content published after this date"),
  before: z.string().optional().describe("ISO8601 date string to get content published before this date")
}).passthrough();

const getContentSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  id: z.number().describe("Content ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const createContentSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  title: z.string().describe("Content title"),
  content: z.string().optional().describe("Content body"),
  status: z.string().optional().default('draft').describe("Content status"),
  excerpt: z.string().optional().describe("Content excerpt"),
  slug: z.string().optional().describe("Content slug"),
  author: z.number().optional().describe("Author ID"),
  parent: z.number().optional().describe("Parent ID (for hierarchical content)"),
  categories: z.array(z.number()).optional().describe("Array of category IDs (for posts)"),
  tags: z.array(z.number()).optional().describe("Array of tag IDs (for posts)"),
  featured_media: z.number().optional().describe("Featured image ID"),
  format: z.string().optional().describe("Content format"),
  menu_order: z.number().optional().describe("Menu order (for pages)"),
  meta: z.record(z.string(), z.any()).optional().describe("Meta fields"),
  custom_fields: z.record(z.string(), z.any()).optional().describe("Custom fields specific to this content type"),
  fields: z.record(z.string(), z.any()).optional().describe("Structured contract-backed fields. Prefer this over custom_fields when describe_content_type reports preferred_write_mode=fields.")
});

const updateContentSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  id: z.number().describe("Content ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  title: z.string().optional().describe("Content title"),
  content: z.string().optional().describe("Content body"),
  status: z.string().optional().describe("Content status"),
  excerpt: z.string().optional().describe("Content excerpt"),
  slug: z.string().optional().describe("Content slug"),
  author: z.number().optional().describe("Author ID"),
  parent: z.number().optional().describe("Parent ID"),
  categories: z.array(z.number()).optional().describe("Array of category IDs"),
  tags: z.array(z.number()).optional().describe("Array of tag IDs"),
  featured_media: z.number().optional().describe("Featured image ID"),
  format: z.string().optional().describe("Content format"),
  menu_order: z.number().optional().describe("Menu order"),
  meta: z.record(z.string(), z.any()).optional().describe("Meta fields"),
  custom_fields: z.record(z.string(), z.any()).optional().describe("Custom fields"),
  fields: z.record(z.string(), z.any()).optional().describe("Structured contract-backed fields. Prefer this over custom_fields when describe_content_type reports preferred_write_mode=fields.")
});

const deleteContentSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  id: z.number().describe("Content ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  force: z.boolean().optional().describe("Whether to bypass trash and force deletion")
});

const discoverContentTypesSchema = z.object({
  refresh_cache: z.boolean().optional().describe("Force refresh the content types cache"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const describeContentTypeSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  refresh_cache: z.boolean().optional().describe("Force refresh the content type and manifest caches"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const findContentByUrlSchema = z.object({
  url: z.string().describe("The full URL of the content to find"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  update_fields: z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    status: z.string().optional(),
    meta: z.record(z.string(), z.any()).optional(),
    custom_fields: z.record(z.string(), z.any()).optional()
  }).optional().describe("Optional fields to update after finding the content")
});

const getContentBySlugSchema = z.object({
  slug: z.string().describe("The slug to search for"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  content_types: z.array(z.string()).optional().describe("Content types to search in (defaults to all)")
});

// Type definitions
type ListContentParams = z.infer<typeof listContentSchema>;
type GetContentParams = z.infer<typeof getContentSchema>;
type CreateContentParams = z.infer<typeof createContentSchema>;
type UpdateContentParams = z.infer<typeof updateContentSchema>;
type DeleteContentParams = z.infer<typeof deleteContentSchema>;
type DiscoverContentTypesParams = z.infer<typeof discoverContentTypesSchema>;
type DescribeContentTypeParams = z.infer<typeof describeContentTypeSchema>;
type FindContentByUrlParams = z.infer<typeof findContentByUrlSchema>;
type GetContentBySlugParams = z.infer<typeof getContentBySlugSchema>;

function normalizeFocusKeywordValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry).trim()))
      .filter((entry) => entry.length > 0)
      .join(',');

    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function readFocusKeywordFromMeta(metaValue: unknown): string | undefined {
  if (!metaValue || typeof metaValue !== 'object' || Array.isArray(metaValue)) {
    return undefined;
  }

  const meta = metaValue as Record<string, unknown>;
  return normalizeFocusKeywordValue(meta.rank_math_focus_keyword);
}

function readFocusKeywordForRankMathSync(
  payload: Record<string, unknown>,
  input: { meta?: Record<string, unknown>; custom_fields?: Record<string, unknown>; fields?: Record<string, unknown> }
): string | undefined {
  // Preferred source: explicit Rank Math meta in the outgoing payload.
  const fromPayloadMeta = readFocusKeywordFromMeta(payload.meta);
  if (fromPayloadMeta) {
    return fromPayloadMeta;
  }

  // Structured contracts may map into top-level keys.
  const fromPayloadRankMath = normalizeFocusKeywordValue(payload.rank_math_focus_keyword);
  if (fromPayloadRankMath) {
    return fromPayloadRankMath;
  }

  const fromPayloadFocusKeyword = normalizeFocusKeywordValue(payload.focus_keyword);
  if (fromPayloadFocusKeyword) {
    return fromPayloadFocusKeyword;
  }

  const fromInputMeta = readFocusKeywordFromMeta(input.meta);
  if (fromInputMeta) {
    return fromInputMeta;
  }

  const fromCustomFieldRankMath = normalizeFocusKeywordValue(input.custom_fields?.rank_math_focus_keyword);
  if (fromCustomFieldRankMath) {
    return fromCustomFieldRankMath;
  }

  const fromCustomFieldFocusKeyword = normalizeFocusKeywordValue(input.custom_fields?.focus_keyword);
  if (fromCustomFieldFocusKeyword) {
    return fromCustomFieldFocusKeyword;
  }

  const fromStructuredRankMath = normalizeFocusKeywordValue(input.fields?.rank_math_focus_keyword);
  if (fromStructuredRankMath) {
    return fromStructuredRankMath;
  }

  return normalizeFocusKeywordValue(input.fields?.focus_keyword);
}

async function syncRankMathFocusKeyword(
  contentId: number,
  focusKeyword: string,
  siteId?: string
): Promise<void> {
  await makeWordPressRequest(
    'POST',
    'updateMeta',
    {
      objectType: 'post',
      objectID: contentId,
      meta: {
        rank_math_focus_keyword: focusKeyword
      }
    },
    {
      siteId,
      namespace: 'rankmath/v1'
    }
  );
}

export const unifiedContentTools: Tool[] = [
  {
    name: "list_content",
    description: "Lists content of any type (posts, pages, or custom post types) with filtering and pagination",
    inputSchema: { type: "object", properties: listContentSchema.shape }
  },
  {
    name: "get_content",
    description: "Gets specific content by ID and content type",
    inputSchema: { type: "object", properties: getContentSchema.shape }
  },
  {
    name: "create_content",
    description: "Creates new content of any type",
    inputSchema: { type: "object", properties: createContentSchema.shape }
  },
  {
    name: "update_content",
    description: "Updates existing content of any type",
    inputSchema: { type: "object", properties: updateContentSchema.shape }
  },
  {
    name: "delete_content",
    description: "Deletes content of any type",
    inputSchema: { type: "object", properties: deleteContentSchema.shape }
  },
  {
    name: "discover_content_types",
    description: "Discovers all available content types (built-in and custom) in the WordPress site",
    inputSchema: { type: "object", properties: discoverContentTypesSchema.shape }
  },
  {
    name: "describe_content_type",
    description: "Returns site-specific guidance, contract metadata, and any plugin-published contract for a content type",
    inputSchema: { type: "object", properties: describeContentTypeSchema.shape }
  },
  {
    name: "find_content_by_url", 
    description: "Finds content by its URL, automatically detecting the content type, and optionally updates it",
    inputSchema: { type: "object", properties: findContentByUrlSchema.shape }
  },
  {
    name: "get_content_by_slug",
    description: "Searches for content by slug across one or more content types",
    inputSchema: { type: "object", properties: getContentBySlugSchema.shape }
  }
];

export const unifiedContentHandlers = {
  list_content: async (params: ListContentParams) => {
    try {
      const preparedRequest = await prepareListContentRequest({
        contentType: params.content_type,
        siteId: params.site_id,
        input: params
      });

      const response = await makeWordPressRequest('GET', preparedRequest.endpoint, preparedRequest.queryParams, {
        siteId: params.site_id,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(response, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      const message =
        error instanceof ContractCompatibilityError
          ? formatContractError(error)
          : `Error listing content: ${error.message}`;

      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: message
          }],
          isError: true
        }
      };
    }
  },

  get_content: async (params: GetContentParams) => {
    try {
      const preparedRequest = await prepareGetContentRequest({
        contentType: params.content_type,
        siteId: params.site_id
      });
      const response = await makeWordPressRequest('GET', `${preparedRequest.endpoint}/${params.id}`, undefined, {
        siteId: params.site_id,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(response, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: `Error getting content: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  create_content: async (params: CreateContentParams) => {
    try {
      const preparedRequest = await prepareContentWriteRequest({
        operation: 'create',
        contentType: params.content_type,
        siteId: params.site_id,
        input: params
      });

      const response = await makeWordPressRequest('POST', preparedRequest.endpoint, preparedRequest.data, {
        siteId: params.site_id,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });

      const warnings: string[] = [];
      const focusKeyword = readFocusKeywordForRankMathSync(preparedRequest.data, params);
      if (focusKeyword && response && typeof response === 'object' && typeof (response as any).id === 'number') {
        const rankMathActive = await isRankMathActive(false, params.site_id);
        if (rankMathActive) {
          try {
            await syncRankMathFocusKeyword((response as any).id, focusKeyword, params.site_id);
          } catch (error: any) {
            const message = `Rank Math focus keyword sync failed: ${error.message}`;
            warnings.push(message);
            logToFile(message);
          }
        } else {
          logToFile('Rank Math plugin is not active; skipping focus keyword sync.');
        }
      }

      const responseWithWarnings =
        warnings.length > 0 && response && typeof response === 'object' && !Array.isArray(response)
          ? { ...(response as Record<string, unknown>), _mcp_warnings: warnings }
          : response;
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(responseWithWarnings, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      const message = error instanceof ContractValidationError || error instanceof ContractCompatibilityError
        ? formatContractError(error)
        : `Error creating content: ${error.message}`;

      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: message 
          }],
          isError: true
        }
      };
    }
  },

  update_content: async (params: UpdateContentParams) => {
    try {
      const preparedRequest = await prepareContentWriteRequest({
        operation: 'update',
        contentType: params.content_type,
        siteId: params.site_id,
        input: params
      });

      const response = await makeWordPressRequest(
        'POST',
        `${preparedRequest.endpoint}/${params.id}`,
        preparedRequest.data,
        {
          siteId: params.site_id,
          namespace: preparedRequest.namespace,
          retry404With: preparedRequest.fallbackOn404
        }
      );

      const warnings: string[] = [];
      const focusKeyword = readFocusKeywordForRankMathSync(preparedRequest.data, params);
      if (focusKeyword) {
        const rankMathActive = await isRankMathActive(false, params.site_id);
        if (rankMathActive) {
          try {
            await syncRankMathFocusKeyword(params.id, focusKeyword, params.site_id);
          } catch (error: any) {
            const message = `Rank Math focus keyword sync failed: ${error.message}`;
            warnings.push(message);
            logToFile(message);
          }
        } else {
          logToFile('Rank Math plugin is not active; skipping focus keyword sync.');
        }
      }

      const responseWithWarnings =
        warnings.length > 0 && response && typeof response === 'object' && !Array.isArray(response)
          ? { ...(response as Record<string, unknown>), _mcp_warnings: warnings }
          : response;
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(responseWithWarnings, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      const message = error instanceof ContractValidationError || error instanceof ContractCompatibilityError
        ? formatContractError(error)
        : `Error updating content: ${error.message}`;

      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: message 
          }],
          isError: true
        }
      };
    }
  },

  delete_content: async (params: DeleteContentParams) => {
    try {
      const endpoint = getContentEndpoint(params.content_type);
      
      const response = await makeWordPressRequest('DELETE', `${endpoint}/${params.id}`, {
        force: params.force || false
      }, { siteId: params.site_id });
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(response, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: `Error deleting content: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  discover_content_types: async (params: DiscoverContentTypesParams) => {
    try {
      const contentTypes = await getPostTypes(params.refresh_cache || false, params.site_id);
      const resolvedContracts = await listResolvedContentTypeContracts(params.site_id, params.refresh_cache || false);
      
      // Format the response to be more readable
      const formattedTypes = Object.entries(contentTypes).map(([slug, type]: [string, any]) => ({
        slug,
        name: type.name,
        description: type.description,
        rest_base: type.rest_base,
        hierarchical: type.hierarchical,
        supports: type.supports,
        taxonomies: type.taxonomies,
        has_extended_schema: resolvedContracts.some(({ contract, executable }) => contract.slug === slug && executable),
        contract_source: resolvedContracts.find(({ contract, executable }) => contract.slug === slug && executable)?.manifest.source || null,
        contract_provider: resolvedContracts.find(({ contract, executable }) => contract.slug === slug && executable)?.manifest.provider || null,
        preferred_write_mode: resolvedContracts.find(({ contract, executable }) => contract.slug === slug && executable)?.contract.preferred_write_mode || null,
        interpreter_ready: resolvedContracts.find(({ contract }) => contract.slug === slug)?.executable || false
      }));
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(formattedTypes, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: `Error discovering content types: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  describe_content_type: async (params: DescribeContentTypeParams) => {
    try {
      const resolvedSiteId = siteManager.resolveSiteId(params.site_id);
      const [contentTypes, contractResolution, manifestState] = await Promise.all([
        getPostTypes(params.refresh_cache || false, resolvedSiteId),
        resolveContentTypeContract(params.content_type, resolvedSiteId, params.refresh_cache || false),
        loadSiteManifests(resolvedSiteId, params.refresh_cache || false)
      ]);

      const wordpressType = contentTypes[params.content_type];
      const contractDescription =
        contractResolution.contract && contractResolution.manifest
          ? describeContractExecution(
              contractResolution.contract,
              contractResolution.manifest.provider,
              contractResolution.manifest.schema_version,
              contractResolution.executionSupport
            )
          : null;

      const response = {
        site_id: resolvedSiteId,
        content_type: params.content_type,
        wordpress: wordpressType
          ? {
              name: wordpressType.name,
              description: wordpressType.description,
              rest_base: wordpressType.rest_base,
              hierarchical: wordpressType.hierarchical,
              supports: wordpressType.supports,
              taxonomies: wordpressType.taxonomies
            }
          : null,
        contract: {
          status: contractResolution.status,
          has_extended_schema: contractResolution.status === 'supported',
          interpreter_ready: contractResolution.executionSupport.executable,
          message: contractResolution.message || null,
          definition: contractResolution.contract || null,
          source: contractResolution.manifest?.source || null,
          provider: contractResolution.manifest?.provider || null,
          description: contractDescription,
          issues: contractResolution.issues,
          execution_issues: contractResolution.executionSupport.issues
        },
        manifest_cache: {
          fetched_at: manifestState.fetchedAt,
          cache_hit: manifestState.cacheHit,
          issues: manifestState.issues
        }
      };

      return {
        toolResult: {
          content: [{
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{
            type: 'text',
            text: `Error describing content type: ${error.message}`
          }],
          isError: true
        }
      };
    }
  },

  find_content_by_url: async (params: FindContentByUrlParams) => {
    try {
      const { slug, pathHints } = parseUrl(params.url);
      
      if (!slug) {
        throw new Error('Could not extract slug from URL');
      }
      
      logToFile(`Searching for content with slug: ${slug}, path hints: ${pathHints.join('/')}`);
      
      // Try to guess content types based on URL structure
      const priorityTypes: string[] = [];
      
      // Common URL patterns to content type mappings
      const pathMappings: Record<string, string[]> = {
        'documentation': ['documentation', 'docs', 'doc'],
        'docs': ['documentation', 'docs', 'doc'],
        'products': ['product'],
        'portfolio': ['portfolio', 'project'],
        'services': ['service'],
        'testimonials': ['testimonial'],
        'team': ['team_member', 'staff'],
        'events': ['event'],
        'courses': ['course', 'lesson']
      };
      
      // Check path hints for potential content types
      for (const hint of pathHints) {
        const mappedTypes = pathMappings[hint.toLowerCase()];
        if (mappedTypes) {
          priorityTypes.push(...mappedTypes);
        }
      }
      
      // Always check standard content types as fallback
      priorityTypes.push('post', 'page');
      
      // Remove duplicates
      const typesToSearch = [...new Set(priorityTypes)];
      
      // Find the content
      const result = await findContentAcrossTypes(slug, typesToSearch, params.site_id);
      
      if (!result) {
        // If not found in priority types, search all types
        const allResult = await findContentAcrossTypes(slug, undefined, params.site_id);
        if (!allResult) {
          throw new Error(`No content found with URL: ${params.url}`);
        }
        
        const { content, contentType } = allResult;
        
        // Update if requested
        if (params.update_fields) {
          const endpoint = getContentEndpoint(contentType);
          
          const updateData: any = {};
          if (params.update_fields.title !== undefined) updateData.title = params.update_fields.title;
          if (params.update_fields.content !== undefined) updateData.content = params.update_fields.content;
          if (params.update_fields.status !== undefined) updateData.status = params.update_fields.status;
          if (params.update_fields.meta !== undefined) updateData.meta = params.update_fields.meta;
          if (params.update_fields.custom_fields !== undefined) {
            Object.assign(updateData, params.update_fields.custom_fields);
          }
          
          const updatedContent = await makeWordPressRequest('POST', `${endpoint}/${content.id}`, updateData, { siteId: params.site_id });
          const warnings: string[] = [];
          const focusKeyword = readFocusKeywordForRankMathSync(
            updateData,
            {
              meta: params.update_fields.meta,
              custom_fields: params.update_fields.custom_fields
            }
          );
          if (focusKeyword) {
            const rankMathActive = await isRankMathActive(false, params.site_id);
            if (rankMathActive) {
              try {
                await syncRankMathFocusKeyword(content.id, focusKeyword, params.site_id);
              } catch (error: any) {
                const message = `Rank Math focus keyword sync failed: ${error.message}`;
                warnings.push(message);
                logToFile(message);
              }
            } else {
              logToFile('Rank Math plugin is not active; skipping focus keyword sync.');
            }
          }
          const updatedContentWithWarnings =
            warnings.length > 0 && updatedContent && typeof updatedContent === 'object' && !Array.isArray(updatedContent)
              ? { ...(updatedContent as Record<string, unknown>), _mcp_warnings: warnings }
              : updatedContent;
          
          return {
            toolResult: {
              content: [{ 
                type: 'text', 
                text: JSON.stringify({
                  found: true,
                  content_type: contentType,
                  content_id: content.id,
                  original_url: params.url,
                  updated: true,
                  content: updatedContentWithWarnings
                }, null, 2)
              }],
              isError: false
            }
          };
        }
        
        return {
          toolResult: {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                found: true,
                content_type: contentType,
                content_id: content.id,
                original_url: params.url,
                content: content
              }, null, 2)
            }],
            isError: false
          }
        };
      }
      
      const { content, contentType } = result;
      
      // Update if requested
      if (params.update_fields) {
        const endpoint = getContentEndpoint(contentType);
        
        const updateData: any = {};
        if (params.update_fields.title !== undefined) updateData.title = params.update_fields.title;
        if (params.update_fields.content !== undefined) updateData.content = params.update_fields.content;
        if (params.update_fields.status !== undefined) updateData.status = params.update_fields.status;
        if (params.update_fields.meta !== undefined) updateData.meta = params.update_fields.meta;
        if (params.update_fields.custom_fields !== undefined) {
          Object.assign(updateData, params.update_fields.custom_fields);
        }
        
        const updatedContent = await makeWordPressRequest('POST', `${endpoint}/${content.id}`, updateData, { siteId: params.site_id });
        const warnings: string[] = [];
        const focusKeyword = readFocusKeywordForRankMathSync(
          updateData,
          {
            meta: params.update_fields.meta,
            custom_fields: params.update_fields.custom_fields
          }
        );
        if (focusKeyword) {
          const rankMathActive = await isRankMathActive(false, params.site_id);
          if (rankMathActive) {
            try {
              await syncRankMathFocusKeyword(content.id, focusKeyword, params.site_id);
            } catch (error: any) {
              const message = `Rank Math focus keyword sync failed: ${error.message}`;
              warnings.push(message);
              logToFile(message);
            }
          } else {
            logToFile('Rank Math plugin is not active; skipping focus keyword sync.');
          }
        }
        const updatedContentWithWarnings =
          warnings.length > 0 && updatedContent && typeof updatedContent === 'object' && !Array.isArray(updatedContent)
            ? { ...(updatedContent as Record<string, unknown>), _mcp_warnings: warnings }
            : updatedContent;
        
        return {
          toolResult: {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                found: true,
                content_type: contentType,
                content_id: content.id,
                original_url: params.url,
                updated: true,
                content: updatedContentWithWarnings
              }, null, 2)
            }],
            isError: false
          }
        };
      }
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              found: true,
              content_type: contentType,
              content_id: content.id,
              original_url: params.url,
              content: content
            }, null, 2)
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: `Error finding content by URL: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  get_content_by_slug: async (params: GetContentBySlugParams) => {
    try {
      const result = await findContentAcrossTypes(params.slug, params.content_types, params.site_id);
      
      if (!result) {
        throw new Error(`No content found with slug: ${params.slug}`);
      }
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              found: true,
              content_type: result.contentType,
              content: result.content
            }, null, 2)
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: `Error getting content by slug: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  }
};

// src/tools/unified-taxonomies.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeWordPressRequest, logToFile } from '../wordpress.js';
import { z } from 'zod';
import { prepareGetContentRequest } from '../content/read-preparation.js';

// Cache for taxonomies to reduce API calls (keyed per site)
const taxonomiesCache = new Map<string, { value: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Helper function to get all taxonomies with caching
async function getTaxonomies(forceRefresh = false, siteId?: string) {
  const now = Date.now();
  const cacheKey = siteId || '__default__';
  const cached = taxonomiesCache.get(cacheKey);

  if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_DURATION) {
    logToFile('Using cached taxonomies');
    return cached.value;
  }

  try {
    logToFile('Fetching taxonomies from API');
    const response = await makeWordPressRequest('GET', 'taxonomies', undefined, { siteId });
    taxonomiesCache.set(cacheKey, { value: response, timestamp: now });
    return response;
  } catch (error: any) {
    logToFile(`Error fetching taxonomies: ${error.message}`);
    throw error;
  }
}

// EventON-style plugin endpoints expose taxonomy terms embedded as label arrays
// (e.g. event_type: ["Long ride"]) rather than wp/v2 term-ID arrays. Object arrays
// carrying term_id that are not taxonomies (organizers, related events) are excluded.
const NON_TAXONOMY_OBJECT_FIELDS = new Set(['organizers', 'organizer', 'related_events', 'faqs']);

export function normalizeEmbeddedTerms(value: unknown): any[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (typeof entry === 'string') {
      return { name: entry };
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      return {
        ...(obj.term_id !== undefined ? { id: obj.term_id } : {}),
        ...(obj.name !== undefined ? { name: obj.name } : {}),
        ...(obj.slug !== undefined ? { slug: obj.slug } : {})
      };
    }
    return { name: String(entry) };
  });
}

// Decides whether a field on a plugin content object represents taxonomy terms.
export function isEmbeddedTermField(key: string, value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  if (value.every((entry) => typeof entry === 'string')) {
    return true;
  }
  if (NON_TAXONOMY_OBJECT_FIELDS.has(key)) {
    return false;
  }
  return value.every((entry) => entry && typeof entry === 'object' && 'term_id' in (entry as object));
}

// Helper function to get the correct endpoint for a taxonomy
function getTaxonomyEndpoint(taxonomy: string): string {
  const endpointMap: Record<string, string> = {
    'category': 'categories',
    'post_tag': 'tags',
    'nav_menu': 'menus',
    'link_category': 'link_categories'
  };
  
  return endpointMap[taxonomy] || taxonomy;
}

// Helper function to get the correct content endpoint
function getContentEndpoint(contentType: string): string {
  const endpointMap: Record<string, string> = {
    'post': 'posts',
    'page': 'pages'
  };
  
  return endpointMap[contentType] || contentType;
}

// Schema definitions
const discoverTaxonomiesSchema = z.object({
  content_type: z.string().optional().describe("Limit results to taxonomies associated with a specific content type"),
  refresh_cache: z.boolean().optional().describe("Force refresh the taxonomies cache"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const listTermsSchema = z.object({
  taxonomy: z.string().describe("The taxonomy slug (e.g., 'category', 'post_tag', or custom taxonomies)"),
  page: z.number().optional().describe("Page number (default 1)"),
  per_page: z.number().min(1).max(100).optional().describe("Items per page (default 10, max 100)"),
  search: z.string().optional().describe("Search term for term name"),
  parent: z.number().optional().describe("Parent term ID to retrieve direct children"),
  slug: z.string().optional().describe("Limit result to terms with a specific slug"),
  hide_empty: z.boolean().optional().describe("Whether to hide terms not assigned to any content"),
  orderby: z.enum(['id', 'include', 'name', 'slug', 'term_group', 'description', 'count']).optional().describe("Sort terms by parameter"),
  order: z.enum(['asc', 'desc']).optional().describe("Order sort attribute"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const getTermSchema = z.object({
  taxonomy: z.string().describe("The taxonomy slug"),
  id: z.number().describe("Term ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const createTermSchema = z.object({
  taxonomy: z.string().describe("The taxonomy slug"),
  name: z.string().describe("Term name"),
  slug: z.string().optional().describe("Term slug"),
  parent: z.number().optional().describe("Parent term ID"),
  description: z.string().optional().describe("Term description"),
  meta: z.record(z.string(), z.any()).optional().describe("Term meta fields"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const updateTermSchema = z.object({
  taxonomy: z.string().describe("The taxonomy slug"),
  id: z.number().describe("Term ID"),
  name: z.string().optional().describe("Term name"),
  slug: z.string().optional().describe("Term slug"),
  parent: z.number().optional().describe("Parent term ID"),
  description: z.string().optional().describe("Term description"),
  meta: z.record(z.string(), z.any()).optional().describe("Term meta fields"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const deleteTermSchema = z.object({
  taxonomy: z.string().describe("The taxonomy slug"),
  id: z.number().describe("Term ID"),
  force: z.boolean().optional().describe("Required to be true, as terms do not support trashing"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const assignTermsToContentSchema = z.object({
  content_id: z.number().describe("The content ID"),
  content_type: z.string().describe("The content type slug"),
  taxonomy: z.string().describe("The taxonomy slug"),
  terms: z.array(z.union([z.number(), z.string()])).describe("Array of term IDs or slugs to assign"),
  append: z.boolean().optional().describe("If true, append terms to existing ones. If false, replace all terms"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

const getContentTermsSchema = z.object({
  content_id: z.number().describe("The content ID"),
  content_type: z.string().describe("The content type slug"),
  taxonomy: z.string().optional().describe("Specific taxonomy to retrieve terms from (if not specified, returns all)"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)")
});

// Type definitions
type DiscoverTaxonomiesParams = z.infer<typeof discoverTaxonomiesSchema>;
type ListTermsParams = z.infer<typeof listTermsSchema>;
type GetTermParams = z.infer<typeof getTermSchema>;
type CreateTermParams = z.infer<typeof createTermSchema>;
type UpdateTermParams = z.infer<typeof updateTermSchema>;
type DeleteTermParams = z.infer<typeof deleteTermSchema>;
type AssignTermsToContentParams = z.infer<typeof assignTermsToContentSchema>;
type GetContentTermsParams = z.infer<typeof getContentTermsSchema>;

export const unifiedTaxonomyTools: Tool[] = [
  {
    name: "discover_taxonomies",
    description: "Discovers all available taxonomies (built-in and custom) in the WordPress site",
    inputSchema: { type: "object", properties: discoverTaxonomiesSchema.shape }
  },
  {
    name: "list_terms",
    description: "Lists terms in any taxonomy (categories, tags, or custom taxonomies) with filtering and pagination",
    inputSchema: { type: "object", properties: listTermsSchema.shape }
  },
  {
    name: "get_term",
    description: "Gets a specific term by ID from any taxonomy",
    inputSchema: { type: "object", properties: getTermSchema.shape }
  },
  {
    name: "create_term",
    description: "Creates a new term in any taxonomy",
    inputSchema: { type: "object", properties: createTermSchema.shape }
  },
  {
    name: "update_term",
    description: "Updates an existing term in any taxonomy",
    inputSchema: { type: "object", properties: updateTermSchema.shape }
  },
  {
    name: "delete_term",
    description: "Deletes a term from any taxonomy",
    inputSchema: { type: "object", properties: deleteTermSchema.shape }
  },
  {
    name: "assign_terms_to_content",
    description: "Assigns taxonomy terms to content of any type",
    inputSchema: { type: "object", properties: assignTermsToContentSchema.shape }
  },
  {
    name: "get_content_terms",
    description: "Gets all taxonomy terms assigned to content of any type",
    inputSchema: { type: "object", properties: getContentTermsSchema.shape }
  }
];

export const unifiedTaxonomyHandlers = {
  discover_taxonomies: async (params: DiscoverTaxonomiesParams) => {
    try {
      const taxonomies = await getTaxonomies(params.refresh_cache || false, params.site_id);

      // Filter by content type if specified
      let filteredTaxonomies = taxonomies;
      if (params.content_type) {
        filteredTaxonomies = Object.fromEntries(
          Object.entries(taxonomies).filter(([_, tax]: [string, any]) => 
            tax.types && tax.types.includes(params.content_type)
          )
        );
      }
      
      // Format the response to be more readable
      const formattedTaxonomies = Object.entries(filteredTaxonomies).map(([slug, tax]: [string, any]) => ({
        slug,
        name: tax.name,
        description: tax.description,
        types: tax.types,
        hierarchical: tax.hierarchical,
        rest_base: tax.rest_base,
        labels: tax.labels
      }));
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(formattedTaxonomies, null, 2) 
          }],
          isError: false
        }
      };
    } catch (error: any) {
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: `Error discovering taxonomies: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  list_terms: async (params: ListTermsParams) => {
    try {
      const endpoint = getTaxonomyEndpoint(params.taxonomy);
      const { taxonomy, site_id, ...queryParams } = params;

      const response = await makeWordPressRequest('GET', endpoint, queryParams, { siteId: site_id });
      
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
            text: `Error listing terms: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  get_term: async (params: GetTermParams) => {
    try {
      const endpoint = getTaxonomyEndpoint(params.taxonomy);

      const response = await makeWordPressRequest('GET', `${endpoint}/${params.id}`, undefined, { siteId: params.site_id });
      
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
            text: `Error getting term: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  create_term: async (params: CreateTermParams) => {
    try {
      const endpoint = getTaxonomyEndpoint(params.taxonomy);
      
      const termData: any = {
        name: params.name
      };
      
      if (params.slug !== undefined) termData.slug = params.slug;
      if (params.parent !== undefined) termData.parent = params.parent;
      if (params.description !== undefined) termData.description = params.description;
      if (params.meta !== undefined) termData.meta = params.meta;

      const response = await makeWordPressRequest('POST', endpoint, termData, { siteId: params.site_id });
      
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
            text: `Error creating term: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  update_term: async (params: UpdateTermParams) => {
    try {
      const endpoint = getTaxonomyEndpoint(params.taxonomy);
      
      const updateData: any = {};
      
      if (params.name !== undefined) updateData.name = params.name;
      if (params.slug !== undefined) updateData.slug = params.slug;
      if (params.parent !== undefined) updateData.parent = params.parent;
      if (params.description !== undefined) updateData.description = params.description;
      if (params.meta !== undefined) updateData.meta = params.meta;

      const response = await makeWordPressRequest('POST', `${endpoint}/${params.id}`, updateData, { siteId: params.site_id });
      
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
            text: `Error updating term: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  delete_term: async (params: DeleteTermParams) => {
    try {
      const endpoint = getTaxonomyEndpoint(params.taxonomy);
      
      const response = await makeWordPressRequest('DELETE', `${endpoint}/${params.id}`, {
        force: true // Terms require force to be true
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
            text: `Error deleting term: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  assign_terms_to_content: async (params: AssignTermsToContentParams) => {
    try {
      // Determine the content endpoint
      const contentEndpoint = getContentEndpoint(params.content_type);
      
      // Prepare the update data
      const updateData: any = {};
      
      // The field name depends on the taxonomy
      if (params.taxonomy === 'category') {
        updateData.categories = params.terms;
      } else if (params.taxonomy === 'post_tag') {
        updateData.tags = params.terms;
      } else {
        // For custom taxonomies, use the taxonomy slug as the field name
        updateData[params.taxonomy] = params.terms;
      }
      
      // If appending, we need to get current terms first
      if (params.append) {
        try {
          const currentContent = await makeWordPressRequest('GET', `${contentEndpoint}/${params.content_id}`, undefined, { siteId: params.site_id });
          const currentTerms = currentContent[params.taxonomy === 'category' ? 'categories' : 
                                              params.taxonomy === 'post_tag' ? 'tags' : 
                                              params.taxonomy] || [];
          
          // Merge current terms with new terms (remove duplicates)
          const allTerms = [...new Set([...currentTerms, ...params.terms])];
          updateData[params.taxonomy === 'category' ? 'categories' : 
                     params.taxonomy === 'post_tag' ? 'tags' : 
                     params.taxonomy] = allTerms;
        } catch (error) {
          // If we can't get current terms, just set the new ones
          logToFile(`Warning: Could not get current terms for append operation: ${error}`);
        }
      }
      
      const response = await makeWordPressRequest('POST', `${contentEndpoint}/${params.content_id}`, updateData, { siteId: params.site_id });

      return {
        toolResult: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              content_id: params.content_id,
              content_type: params.content_type,
              taxonomy: params.taxonomy,
              assigned_terms: params.terms,
              appended: params.append || false,
              content: response
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
            text: `Error assigning terms to content: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  },

  get_content_terms: async (params: GetContentTermsParams) => {
    try {
      // First, get the content to see what taxonomies are assigned. Use the same
      // contract-aware routing get_content relies on, so content types that aren't
      // REST-exposed (e.g. EventON `ajde_events`) resolve via their plugin endpoint
      // instead of 404ing against wp/v2.
      const preparedRequest = await prepareGetContentRequest({
        contentType: params.content_type,
        siteId: params.site_id
      });
      const fallbackOn404 = preparedRequest.fallbackOn404
        ? {
            endpoint: `${preparedRequest.fallbackOn404.endpoint}/${params.content_id}`,
            namespace: preparedRequest.fallbackOn404.namespace
          }
        : undefined;
      const content = await makeWordPressRequest(
        'GET',
        `${preparedRequest.endpoint}/${params.content_id}`,
        undefined,
        {
          siteId: params.site_id,
          namespace: preparedRequest.namespace,
          retry404With: fallbackOn404
        }
      );

      const terms: any = {};

      // Plugin endpoints (e.g. EventON `eventonapify/v1`) return their own object
      // shape that embeds taxonomy terms as label arrays instead of wp/v2 term-ID
      // arrays, and some of their taxonomies aren't even REST-registered. Read those
      // terms directly off the object rather than walking wp/v2 term endpoints.
      const isPluginObject = Boolean(preparedRequest.namespace && preparedRequest.namespace !== 'wp/v2');

      if (isPluginObject) {
        if (params.taxonomy) {
          const field = params.taxonomy === 'post_tag' ? 'tags' : params.taxonomy;
          const embedded = normalizeEmbeddedTerms(content?.[field]);
          if (embedded.length > 0) {
            terms[params.taxonomy] = embedded;
          }
        } else {
          for (const [key, value] of Object.entries(content || {})) {
            if (isEmbeddedTermField(key, value)) {
              const taxonomySlug = key === 'tags' ? 'post_tag' : key;
              terms[taxonomySlug] = normalizeEmbeddedTerms(value);
            }
          }
        }
      } else {
        // Standard wp/v2 path: taxonomy fields hold term IDs; resolve each to detail.
        const taxonomies = await getTaxonomies(false, params.site_id);

        if (params.taxonomy) {
          const taxonomyField = params.taxonomy === 'category' ? 'categories' :
                                params.taxonomy === 'post_tag' ? 'tags' :
                                params.taxonomy;

          if (content[taxonomyField]) {
            const endpoint = getTaxonomyEndpoint(params.taxonomy);
            const termDetails = await Promise.all(
              content[taxonomyField].map(async (termId: number) => {
                try {
                  return await makeWordPressRequest('GET', `${endpoint}/${termId}`, undefined, { siteId: params.site_id });
                } catch {
                  return { id: termId, error: 'Could not fetch term details' };
                }
              })
            );
            terms[params.taxonomy] = termDetails;
          }
        } else {
          for (const [taxonomySlug, taxonomyInfo] of Object.entries(taxonomies)) {
            const tax = taxonomyInfo as any;
            if (tax.types && tax.types.includes(params.content_type)) {
              const taxonomyField = taxonomySlug === 'category' ? 'categories' :
                                    taxonomySlug === 'post_tag' ? 'tags' :
                                    taxonomySlug;

              if (content[taxonomyField] && Array.isArray(content[taxonomyField]) && content[taxonomyField].length > 0) {
                const endpoint = getTaxonomyEndpoint(taxonomySlug);
                const termDetails = await Promise.all(
                  content[taxonomyField].map(async (termId: number) => {
                    try {
                      return await makeWordPressRequest('GET', `${endpoint}/${termId}`, undefined, { siteId: params.site_id });
                    } catch {
                      return { id: termId, error: 'Could not fetch term details' };
                    }
                  })
                );
                terms[taxonomySlug] = termDetails;
              }
            }
          }
        }
      }

      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              content_id: params.content_id,
              content_type: params.content_type,
              terms: terms
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
            text: `Error getting content terms: ${error.message}` 
          }],
          isError: true
        }
      };
    }
  }
};
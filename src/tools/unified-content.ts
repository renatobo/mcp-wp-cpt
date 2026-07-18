// src/tools/unified-content.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeWordPressRequest, logToFile } from '../wordpress.js';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { marked } from 'marked';
import {
  applyContentEdit,
  CONTENT_EDIT_OPERATIONS,
  ContentEditOperation,
  ContentEditParams,
  validateContentEdit
} from '../content/content-edit.js';

export { applyContentEdit } from '../content/content-edit.js';
import { siteManager } from '../config/site-manager.js';
import { listResolvedContentTypeContracts, resolveContentTypeContract } from '../adapters/registry.js';
import { loadSiteManifests } from '../adapters/manifest-loader.js';
import { describeContractExecution } from '../adapters/interpreter.js';
import {
  attachContentIdToPreparedRequest,
  formatContractError,
  prepareContentDeleteRequest,
  prepareContentWriteRequest
} from '../content/write-preparation.js';
import { extractContentCollection, findItemBySlug } from '../content/utils.js';
import { prepareGetContentRequest, prepareListContentRequest } from '../content/read-preparation.js';
import { ContractCompatibilityError, ContractValidationError } from '../adapters/types.js';

const CACHE_DIR = process.env.UNIFIED_CONTENT_CACHE_DIR
  ? path.resolve(process.env.UNIFIED_CONTENT_CACHE_DIR)
  : path.join(os.tmpdir(), 'mcp-wp', '.cache');

fs.ensureDir(CACHE_DIR).catch(() => {});

// Cache for post types to reduce API calls
const postTypesCache = new Map<string, { value: any; timestamp: number }>();
const CACHE_DURATION = parseInt(process.env.WORDPRESS_CACHE_DURATION || `${5 * 60 * 1000}`, 10);
const rankMathActiveCache = new Map<string, { value: boolean; timestamp: number }>();

async function loadCacheFromDisk(siteId: string): Promise<{ data: any; timestamp: number } | null> {
  try {
    await fs.ensureDir(CACHE_DIR);
    const cacheFilePath = path.join(CACHE_DIR, `content-types-${siteId}.json`);

    if (await fs.pathExists(cacheFilePath)) {
      return await fs.readJson(cacheFilePath);
    }
  } catch (error) {
    logToFile(`Failed to load content type cache from disk: ${error}`, 'debug');
  }

  return null;
}

async function saveCacheToDisk(siteId: string, data: any): Promise<void> {
  try {
    await fs.ensureDir(CACHE_DIR);
    const cacheFilePath = path.join(CACHE_DIR, `content-types-${siteId}.json`);
    await fs.writeJson(cacheFilePath, {
      data,
      timestamp: Date.now()
    });
  } catch (error) {
    logToFile(`Failed to save content type cache to disk: ${error}`, 'debug');
  }
}

// Helper function to get all post types with caching
async function getPostTypes(forceRefresh = false, siteId?: string) {
  const now = Date.now();
  const resolvedSiteId = siteManager.resolveSiteId(siteId);
  const cacheEntry = postTypesCache.get(resolvedSiteId);

  if (!forceRefresh && cacheEntry && (now - cacheEntry.timestamp) < CACHE_DURATION) {
    logToFile('Using memory-cached post types', 'debug');
    return cacheEntry.value;
  }

  if (!forceRefresh) {
    const diskCache = await loadCacheFromDisk(resolvedSiteId);
    if (diskCache && (now - diskCache.timestamp) < CACHE_DURATION) {
      logToFile('Using disk-cached post types', 'debug');
      postTypesCache.set(resolvedSiteId, {
        value: diskCache.data,
        timestamp: diskCache.timestamp
      });
      return diskCache.data;
    }
  }

  try {
    logToFile('Fetching post types from API', 'info');
    const response = await makeWordPressRequest('GET', 'types', undefined, { siteId: resolvedSiteId });
    postTypesCache.set(resolvedSiteId, {
      value: response,
      timestamp: now
    });
    await saveCacheToDisk(resolvedSiteId, response);
    return response;
  } catch (error: any) {
    logToFile(`Error fetching post types: ${error.message}`, 'error');
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

// Helper function to get the correct endpoint for a content type.
// Exported for reuse by unified-taxonomies.ts (assign_terms_to_content / get_content_terms).
// Resolves custom post types to their rest_base; falls back to the type as-is.
export async function getContentEndpoint(contentType: string, siteId?: string): Promise<string> {
  // Quick return for standard types
  const standardMap: Record<string, string> = {
    'post': 'posts',
    'page': 'pages'
  };

  if (standardMap[contentType]) {
    return standardMap[contentType];
  }

  // For custom post types, we need to get the rest_base from discovered types
  try {
    const postTypes = await getPostTypes(false, siteId);
    if (postTypes[contentType] && postTypes[contentType].rest_base) {
      return postTypes[contentType].rest_base;
    }
  } catch (error) {
    logToFile(`Failed to get rest_base for content type ${contentType}: ${error}`);
  }

  // Fallback: try the content type as-is
  logToFile(`Warning: No rest_base found for content type '${contentType}', using as-is`);
  return contentType;
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

// Derives a full-text search term from a slug (e.g. "official-clubs-week-2026"
// -> "official clubs week 2026") for endpoints that honor `search` but not `slug`.
function slugToSearchTerm(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Helper function to find content across multiple post types
async function findContentAcrossTypes(slug: string, contentTypes?: string[], siteId?: string) {
  const typesToSearch = contentTypes || [];

  // If no specific content types provided, get all available types
  if (typesToSearch.length === 0) {
    const allTypes = await getPostTypes(false, siteId);
    const typeSet = new Set<string>(
      Object.keys(allTypes).filter(type => type !== 'attachment' && type !== 'wp_block')
    );

    // Include contract-backed types that aren't exposed in the standard REST API
    // (e.g. EventON `ajde_events` registered with show_in_rest=false), so they are
    // resolvable by slug/URL just like list_content can enumerate them.
    try {
      const resolvedContracts = await listResolvedContentTypeContracts(siteId, false);
      for (const { contract } of resolvedContracts) {
        // Nested contracts (e.g. event_rsvps) require parent context and can't be resolved by slug alone.
        if (contract.parent_context) {
          continue;
        }
        typeSet.add(contract.slug);
      }
    } catch (error) {
      logToFile(`Could not load contract-backed types for slug search: ${error}`, 'debug');
    }

    typesToSearch.push(...typeSet);
  }

  logToFile(`Searching for slug "${slug}" across content types: ${typesToSearch.join(', ')}`, 'debug');

  const searchOne = async (contentType: string) => {
    try {
      // Use the same contract-aware routing list_content relies on, so content
      // types that aren't REST-exposed still resolve via their plugin endpoint.
      const preparedRequest = await prepareListContentRequest({
        contentType,
        siteId,
        input: { slug, per_page: 100 }
      });

      const response = await makeWordPressRequest('GET', preparedRequest.endpoint, preparedRequest.queryParams, {
        siteId,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });

      const items = extractContentCollection(response);
      // For wp/v2 array responses the `slug` filter is honored server-side, so the
      // result is authoritative: match by slug, or accept a lone server-filtered row.
      let match = findItemBySlug(items, slug) || (Array.isArray(response) && items.length === 1 ? items[0] : undefined);

      // Plugin endpoints return an enveloped response (e.g. EventON `{ events: [...] }`)
      // and ignore the `slug` query param entirely, so the first attempt above can't
      // confirm a match. Retry with a search term derived from the slug (which these
      // endpoints do honor) and match the exact slug client-side.
      if (!match && !Array.isArray(response)) {
        const searchRequest = await prepareListContentRequest({
          contentType,
          siteId,
          input: { search: slugToSearchTerm(slug), per_page: 100 }
        });

        const searchResponse = await makeWordPressRequest('GET', searchRequest.endpoint, searchRequest.queryParams, {
          siteId,
          namespace: searchRequest.namespace,
          retry404With: searchRequest.fallbackOn404
        });

        match = findItemBySlug(extractContentCollection(searchResponse), slug);
      }

      if (match) {
        logToFile(`Found content with slug "${slug}" in content type "${contentType}"`, 'info');
        return { content: match, contentType };
      }
    } catch (error) {
      logToFile(`Error searching ${contentType}: ${error}`, 'debug');
    }

    return null;
  };

  if (process.env.WORDPRESS_PARALLEL_SEARCH !== 'false' && typesToSearch.length > 1) {
    const results = await Promise.all(typesToSearch.map(searchOne));
    const found = results.find((result) => result !== null);
    if (found) {
      return found;
    }

    return null;
  }

  for (const contentType of typesToSearch) {
    const result = await searchOne(contentType);
    if (result) {
      return result;
    }
  }
  
  return null;
}

// URL → post-type hint table used when resolving a public WP URL to its content type.
const URL_PATH_TYPE_HINTS: Record<string, string[]> = {
  'documentation': ['documentation', 'docs', 'doc'],
  'docs': ['documentation', 'docs', 'doc'],
  'products': ['product'],
  'portfolio': ['portfolio', 'project'],
  'services': ['service'],
  'testimonials': ['testimonial'],
  'team': ['team_member', 'staff'],
  'events': ['ajde_events', 'event'],
  'event': ['ajde_events', 'event'],
  'courses': ['course', 'lesson']
};

/**
 * Resolve a public WordPress URL to the underlying post by parsing the slug
 * and path hints, searching priority content types first and then falling back
 * to all available content types. Returns null when no content matches.
 *
 * Throws when the URL cannot be parsed into a slug — callers can surface that
 * as a distinct error from the not-found case.
 */
export async function findContentByUrl(
  url: string,
  siteId?: string
): Promise<{ content: any; contentType: string } | null> {
  const { slug, pathHints } = parseUrl(url);

  if (!slug) {
    throw new Error('Could not extract slug from URL');
  }

  const priorityTypes: string[] = [];
  for (const hint of pathHints) {
    const mapped = URL_PATH_TYPE_HINTS[hint.toLowerCase()];
    if (mapped) priorityTypes.push(...mapped);
  }
  priorityTypes.push('post', 'page');
  const typesToSearch = [...new Set(priorityTypes)];

  const result = await findContentAcrossTypes(slug, typesToSearch, siteId);
  if (result) return result;

  return findContentAcrossTypes(slug, undefined, siteId);
}

// Content format types
type ContentFormat = 'auto' | 'markdown' | 'html' | 'blocks';
type DetectedFormat = 'blocks' | 'html' | 'markdown' | 'text';
function detectContentFormat(content: string): DetectedFormat {
  if (/<!--\s*wp:/.test(content)) {
    return 'blocks';
  }

  if (/<[a-z][\s\S]*>/i.test(content)) {
    return 'html';
  }

  const markdownPatterns = [
    /^#{1,6}\s+/m,
    /\*\*[^*]+\*\*/,
    /\*[^*]+\*/,
    /\[[^\]]+\]\([^)]+\)/,
    /^[-*+]\s+/m,
    /^\d+\.\s+/m,
    /^>\s+/m,
    /`[^`]+`/,
    /^```/m,
    /!\[[^\]]*\]\([^)]+\)/,
    /^---$/m,
    /^\|.*\|$/m
  ];

  return markdownPatterns.some((pattern) => pattern.test(content)) ? 'markdown' : 'text';
}

async function convertMarkdownToHtml(markdown: string): Promise<string> {
  try {
    return await marked(markdown, {
      gfm: true,
      breaks: false
    });
  } catch (error) {
    logToFile(`Error converting markdown to HTML: ${error}`, 'error');
    throw error;
  }
}

function convertHtmlToBlocks(html: string): string {
  const blocks: string[] = [];
  const blockRegex = /<(p|h[1-6]|ul|ol|blockquote|pre|table|hr|div)[^>]*>[\s\S]*?<\/\1>|<(hr|br)\s*\/?>/gi;
  let match;
  let lastIndex = 0;

  while ((match = blockRegex.exec(html)) !== null) {
    const textBefore = html.slice(lastIndex, match.index).trim();
    if (textBefore) {
      blocks.push(`<!-- wp:paragraph -->\n<p>${textBefore}</p>\n<!-- /wp:paragraph -->`);
    }

    const element = match[0];
    const tagName = (match[1] || match[2] || '').toLowerCase();

    switch (tagName) {
      case 'p':
        blocks.push(`<!-- wp:paragraph -->\n${element}\n<!-- /wp:paragraph -->`);
        break;
      case 'h1':
        blocks.push(`<!-- wp:heading {"level":1} -->\n${element}\n<!-- /wp:heading -->`);
        break;
      case 'h2':
        blocks.push(`<!-- wp:heading -->\n${element}\n<!-- /wp:heading -->`);
        break;
      case 'h3':
        blocks.push(`<!-- wp:heading {"level":3} -->\n${element}\n<!-- /wp:heading -->`);
        break;
      case 'h4':
        blocks.push(`<!-- wp:heading {"level":4} -->\n${element}\n<!-- /wp:heading -->`);
        break;
      case 'h5':
        blocks.push(`<!-- wp:heading {"level":5} -->\n${element}\n<!-- /wp:heading -->`);
        break;
      case 'h6':
        blocks.push(`<!-- wp:heading {"level":6} -->\n${element}\n<!-- /wp:heading -->`);
        break;
      case 'ul':
        blocks.push(`<!-- wp:list -->\n${element}\n<!-- /wp:list -->`);
        break;
      case 'ol':
        blocks.push(`<!-- wp:list {"ordered":true} -->\n${element}\n<!-- /wp:list -->`);
        break;
      case 'blockquote':
        blocks.push(`<!-- wp:quote -->\n${element}\n<!-- /wp:quote -->`);
        break;
      case 'pre':
        blocks.push(`<!-- wp:code -->\n${element}\n<!-- /wp:code -->`);
        break;
      case 'table':
        blocks.push(`<!-- wp:table -->\n<figure class="wp-block-table">${element}</figure>\n<!-- /wp:table -->`);
        break;
      case 'hr':
        blocks.push(`<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`);
        break;
      default:
        blocks.push(`<!-- wp:paragraph -->\n${element}\n<!-- /wp:paragraph -->`);
    }

    lastIndex = match.index + match[0].length;
  }

  const remaining = html.slice(lastIndex).trim();
  if (remaining) {
    blocks.push(`<!-- wp:paragraph -->\n<p>${remaining}</p>\n<!-- /wp:paragraph -->`);
  }

  if (blocks.length === 0 && html.trim()) {
    return `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;
  }

  return blocks.join('\n\n');
}

async function processContent(
  content: string,
  format: ContentFormat = 'auto',
  convertToBlocks = false
): Promise<string> {
  if (!content || !content.trim()) {
    return content;
  }

  const detectedFormat =
    format === 'auto'
      ? detectContentFormat(content)
      : format === 'blocks'
        ? 'blocks'
        : format === 'html'
          ? 'html'
          : format === 'markdown'
            ? 'markdown'
            : 'text';

  logToFile(`Content format: ${detectedFormat}`, 'debug');

  if (detectedFormat === 'blocks') {
    return content;
  }

  let htmlContent: string;
  if (detectedFormat === 'markdown') {
    htmlContent = await convertMarkdownToHtml(content);
  } else if (detectedFormat === 'html') {
    htmlContent = content;
  } else {
    htmlContent = `<p>${content.replace(/\n\n/g, '</p>\n<p>').replace(/\n/g, '<br>')}</p>`;
  }

  return convertToBlocks ? convertHtmlToBlocks(htmlContent) : htmlContent;
}

async function processWriteContent<T extends { content?: string; content_format?: ContentFormat; convert_to_blocks?: boolean }>(
  input: T
): Promise<T> {
  if (input.content === undefined) {
    return input;
  }

  return {
    ...input,
    content: await processContent(
      input.content,
      input.content_format || 'auto',
      input.convert_to_blocks || false
    )
  };
}

// Resolve an update's body before the contract pipeline runs. When content_edit
// is supplied, fetch the existing raw content (contract-aware), apply the targeted
// edit, and hand the finished body to the pipeline so partial edits work uniformly
// across content types — including contract-backed ones. Otherwise fall back to the
// generic content processing used for full-document writes.
async function resolveWriteInput(params: UpdateContentParams): Promise<UpdateContentParams> {
  if (params.content_edit === undefined) {
    return processWriteContent(params);
  }

  if (params.content !== undefined) {
    throw new Error('Provide either content or content_edit, not both');
  }

  const edit = params.content_edit as ContentEditParams;
  validateContentEdit(edit);

  const existingRaw = await fetchEditableRawContentForType(params.content_type, params.id, params.site_id);
  const processedFragment = await processContent(
    edit.value,
    edit.content_format || 'auto',
    edit.convert_to_blocks || false
  );
  const mergedContent = applyContentEdit(existingRaw, { ...edit, value: processedFragment });

  // The merged body is already in final WordPress form; strip the edit and format
  // hints so the contract pipeline forwards it verbatim instead of reprocessing.
  const { content_edit, content_format, convert_to_blocks, ...rest } = params as any;
  return { ...rest, content: mergedContent } as UpdateContentParams;
}

// Shared update pipeline used by update_content and find_content_by_url so both
// route writes through the contract layer, content_edit resolution, and Rank Math
// focus-keyword sync. Returns the raw WP response plus any non-fatal warnings; each
// caller formats its own envelope.
// Best-effort Rank Math focus-keyword sync. Returns any non-fatal warning to
// surface to the caller; never throws and no-ops when there's nothing to sync.
async function syncRankMathFocusKeywordWithWarnings(
  focusKeyword: string | undefined,
  contentId: number,
  siteId?: string
): Promise<string[]> {
  if (!focusKeyword) {
    return [];
  }
  if (!(await isRankMathActive(false, siteId))) {
    logToFile('Rank Math plugin is not active; skipping focus keyword sync.');
    return [];
  }
  try {
    await syncRankMathFocusKeyword(contentId, focusKeyword, siteId);
    return [];
  } catch (error: any) {
    const message = `Rank Math focus keyword sync failed: ${error.message}`;
    logToFile(message);
    return [message];
  }
}

// Attach collected warnings to an object WP response under _mcp_warnings.
function attachWarnings(response: any, warnings: string[]): any {
  return warnings.length > 0 && response && typeof response === 'object' && !Array.isArray(response)
    ? { ...(response as Record<string, unknown>), _mcp_warnings: warnings }
    : response;
}

async function executeContentUpdate(params: UpdateContentParams): Promise<{ response: any; warnings: string[] }> {
  const input = await resolveWriteInput(params);
  const preparedRequest = await prepareContentWriteRequest({
    operation: 'update',
    contentType: input.content_type,
    siteId: input.site_id,
    input
  });
  const itemRequest = attachContentIdToPreparedRequest(preparedRequest, params.id);

  const response = await makeWordPressRequest('POST', itemRequest.endpoint, itemRequest.data, {
    siteId: params.site_id,
    namespace: itemRequest.namespace,
    retry404With: itemRequest.fallbackOn404
  });

  const focusKeyword = readFocusKeywordForRankMathSync(preparedRequest.data, input);
  const warnings = await syncRankMathFocusKeywordWithWarnings(focusKeyword, params.id, params.site_id);

  return { response, warnings };
}

// Contract-aware read used by get_content and find_content_by_url, optionally
// surfacing a top-level content_raw alias for exact partial-edit targeting.
async function fetchContentForType(
  contentType: string,
  id: number,
  siteId?: string,
  includeRawContent: boolean = false
) {
  const preparedRequest = await prepareGetContentRequest({ contentType, siteId });
  const fallbackOn404 = preparedRequest.fallbackOn404
    ? {
        endpoint: `${preparedRequest.fallbackOn404.endpoint}/${id}`,
        namespace: preparedRequest.fallbackOn404.namespace
      }
    : undefined;
  const response = await makeWordPressRequest(
    'GET',
    `${preparedRequest.endpoint}/${id}`,
    includeRawContent ? { context: 'edit' } : undefined,
    { siteId, namespace: preparedRequest.namespace, retry404With: fallbackOn404 }
  );

  return includeRawContent && response && typeof response === 'object'
    ? withContentRawAlias(response as Record<string, any>)
    : response;
}

// Return the meta keys that were sent in the request but don't appear in
// the WP response's `meta` object. WordPress silently drops unregistered
// meta keys on writes to /wp/v2/{type}/{id}, so absence in the echoed
// response is the signal that a key wasn't persisted. The `responseData`
// is the parsed WP REST response; we look for `responseData.meta` as the
// echoed object. If the response shape is unexpected (no meta object,
// or meta returned as an array rather than the usual keyed object), we
// treat every sent key as dropped — conservative, but matches the
// underlying "we can't confirm it stuck" signal.
export function detectDroppedMetaKeys(
  sent: Record<string, unknown> | undefined,
  responseData: unknown
): string[] {
  if (!sent) return [];
  const sentKeys = Object.keys(sent);
  if (sentKeys.length === 0) return [];
  if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
    return sentKeys;
  }
  const returnedMeta = (responseData as Record<string, unknown>).meta;
  if (!returnedMeta || typeof returnedMeta !== 'object' || Array.isArray(returnedMeta)) {
    return sentKeys;
  }
  const returnedKeys = new Set(Object.keys(returnedMeta as Record<string, unknown>));
  return sentKeys.filter(k => !returnedKeys.has(k));
}

export function buildDroppedMetaWarning(droppedKeys: string[]): string {
  return (
    `Warning: WordPress did not persist these meta keys: ${droppedKeys.join(', ')}. ` +
    `This usually means they are not registered for REST exposure via ` +
    `register_post_meta(..., show_in_rest => true). Common culprits are SEO ` +
    `plugin keys (Yoast _yoast_wpseo_*, Rank Math rank_math_*, AIOSEO _aioseo_*) ` +
    `which the plugins do not expose on the core /wp/v2/ endpoints by default. ` +
    `See README "Meta field limitations" for context.`
  );
}

// Reads the raw content body via the contract-aware route (and 404 fallback) the
// same way get_content does, so partial edits and raw reads work for content types
// that aren't on wp/v2 (e.g. EventON ajde_events).
async function fetchEditableRawContentForType(contentType: string, id: number, siteId?: string): Promise<string> {
  const response = await fetchContentForType(contentType, id, siteId, true);

  const rawContent = (response as any)?.content?.raw;
  if (typeof rawContent !== 'string') {
    throw new Error('Partial content edits require WordPress edit access and a REST response that includes content.raw');
  }

  return rawContent;
}

function withContentRawAlias<T extends Record<string, any>>(response: T): T & { content_raw?: string } {
  const rawContent = response?.content?.raw;
  if (typeof rawContent !== 'string') {
    return response;
  }

  return {
    ...response,
    content_raw: rawContent
  };
}

// Schema definitions
const listContentSchema = z.object({
  content_type: z.string().describe("The content type slug (e.g., 'post', 'page', 'product', 'documentation')"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  event_id: z.number().optional().describe("Parent event ID for contract-backed nested content types such as 'event_rsvps'"),
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
  id: z.coerce.number().describe("Content ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  include_raw_content: z.boolean().optional().default(false).describe(
    "Fetch the content with WordPress edit context and include a top-level content_raw field for exact matching"
  )
});

const createContentSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  title: z.string().describe("Content title"),
  content: z.string().optional().describe(
    "Content body. Accepts Gutenberg blocks, HTML, or Markdown. Markdown is auto-converted to HTML when detected."
  ),
  content_format: z.enum(['auto', 'markdown', 'html', 'blocks']).optional().default('auto').describe(
    "Content format hint: 'auto' (detect and convert), 'markdown', 'html', or 'blocks' (Gutenberg)"
  ),
  convert_to_blocks: z.boolean().optional().default(false).describe(
    "Convert content to Gutenberg blocks. Recommended for sites using block editor."
  ),
  status: z.string().optional().default('draft').describe("Content status"),
  excerpt: z.string().optional().describe("Content excerpt"),
  slug: z.string().optional().describe("Content slug"),
  author: z.number().optional().describe("Author ID"),
  parent: z.number().optional().describe("Parent ID (for hierarchical content)"),
  categories: z.array(z.number()).optional().describe("Array of category IDs (for posts)"),
  tags: z.array(z.number()).optional().describe("Array of tag IDs (for posts)"),
  featured_media: z.number().optional().describe("Featured image ID"),
  format: z.string().optional().describe("Post format (standard, aside, gallery, etc.)"),
  menu_order: z.number().optional().describe("Menu order (for pages)"),
  meta: z.record(z.string(), z.any()).optional().describe("Meta fields"),
  custom_fields: z.record(z.string(), z.any()).optional().describe("Custom fields specific to this content type"),
  fields: z.record(z.string(), z.any()).optional().describe("Structured contract-backed fields. Prefer this over custom_fields when describe_content_type reports preferred_write_mode=fields.")
});

const contentEditSchema = z.object({
  operation: z.enum(CONTENT_EDIT_OPERATIONS).describe(
    "Partial content edit operation: append, prepend, insert_before, insert_after, or replace"
  ),
  value: z.string().describe(
    "Content fragment to insert or use as the replacement. Accepts Gutenberg blocks, HTML, or Markdown."
  ),
  target_text: z.string().optional().describe(
    "Exact raw content fragment to target for insert_before, insert_after, or replace"
  ),
  occurrence: z.number().int().positive().optional().describe(
    "Optional 1-based occurrence to target when target_text appears multiple times"
  ),
  content_format: z.enum(['auto', 'markdown', 'html', 'blocks']).optional().default('auto').describe(
    "Format hint for the content_edit value"
  ),
  convert_to_blocks: z.boolean().optional().default(false).describe(
    "Convert the content_edit value to Gutenberg blocks before applying it"
  )
}).superRefine((value, ctx) => {
  const targetedOperations = new Set<ContentEditOperation>(['insert_before', 'insert_after', 'replace']);
  if (targetedOperations.has(value.operation) && !value.target_text) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `target_text is required for ${value.operation}`,
      path: ['target_text']
    });
  }
});

const updateContentSchemaShape = {
  content_type: z.string().describe("The content type slug"),
  id: z.number().describe("Content ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  title: z.string().optional().describe("Content title"),
  content: z.string().optional().describe(
    "Content body. Accepts Gutenberg blocks, HTML, or Markdown. Markdown is auto-converted to HTML when detected."
  ),
  content_format: z.enum(['auto', 'markdown', 'html', 'blocks']).optional().default('auto').describe(
    "Content format hint: 'auto' (detect and convert), 'markdown', 'html', or 'blocks' (Gutenberg)"
  ),
  convert_to_blocks: z.boolean().optional().default(false).describe(
    "Convert content to Gutenberg blocks. Recommended for sites using block editor."
  ),
  content_edit: contentEditSchema.optional().describe(
    "Apply a targeted edit to the existing raw content instead of replacing the whole document. " +
    "Mutually exclusive with `content` — provide one or the other, not both."
  ),
  status: z.string().optional().describe("Content status"),
  excerpt: z.string().optional().describe("Content excerpt"),
  slug: z.string().optional().describe("Content slug"),
  author: z.number().optional().describe("Author ID"),
  parent: z.number().optional().describe("Parent ID"),
  categories: z.array(z.number()).optional().describe("Array of category IDs"),
  tags: z.array(z.number()).optional().describe("Array of tag IDs"),
  featured_media: z.number().optional().describe("Featured image ID"),
  format: z.string().optional().describe("Post format (standard, aside, gallery, etc.)"),
  menu_order: z.number().optional().describe("Menu order"),
  meta: z.record(z.string(), z.any()).optional().describe("Meta fields"),
  custom_fields: z.record(z.string(), z.any()).optional().describe("Custom fields"),
  fields: z.record(z.string(), z.any()).optional().describe("Structured contract-backed fields. Prefer this over custom_fields when describe_content_type reports preferred_write_mode=fields.")
};

// NOTE: mutual exclusion of `content` and `content_edit` is enforced at runtime
// in resolveUpdatedContent(). A top-level superRefine here would be dead code:
// the MCP server registers tools from the raw shape (updateContentSchemaShape),
// so an outer-object refinement never reaches the validation layer. The
// constraint is documented on the content_edit field description instead.
const updateContentSchema = z.object(updateContentSchemaShape);

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

const findContentByUrlUpdateFieldsShape = {
  title: z.string().optional(),
  content: z.string().optional().describe(
    "Content body. Accepts Gutenberg blocks, HTML, or Markdown (auto-converted to HTML)."
  ),
  content_format: z.enum(['auto', 'markdown', 'html', 'blocks']).optional().default('auto'),
  convert_to_blocks: z.boolean().optional().default(false),
  content_edit: contentEditSchema.optional().describe(
    "Apply a targeted edit to the existing raw content instead of replacing the whole document. " +
    "Mutually exclusive with `content` — provide one or the other, not both."
  ),
  status: z.string().optional(),
  meta: z.record(z.string(), z.any()).optional(),
  custom_fields: z.record(z.string(), z.any()).optional()
};

const findContentByUrlSchema = z.object({
  url: z.string().describe("The full URL of the content to find"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  include_raw_content: z.boolean().optional().default(false).describe(
    "Fetch the matched content with WordPress edit context and include a top-level content_raw field for exact matching"
  ),
  // Mutual exclusion of content/content_edit is enforced at runtime in
  // resolveUpdatedContent() and documented on the content_edit field; an outer
  // superRefine here is dead code (tools register from the raw shape).
  update_fields: z.object(findContentByUrlUpdateFieldsShape).optional().describe("Optional fields to update after finding the content")
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
    inputSchema: { type: "object", properties: updateContentSchemaShape }
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
    inputSchema: { type: "object", properties: {
      url: z.string().describe("The full URL of the content to find"),
      site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
      include_raw_content: z.boolean().optional().default(false).describe(
        "Fetch the matched content with WordPress edit context and include a top-level content_raw field for exact matching"
      ),
      update_fields: z.object(findContentByUrlUpdateFieldsShape).optional().describe("Optional fields to update after finding the content")
    } }
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
      const filteredResponse = applyListContentResponseFilter(response, preparedRequest.responseFilter);
      
      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(filteredResponse, null, 2) 
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
      // Contract-aware read; include_raw_content adds a top-level content_raw alias.
      const response = await fetchContentForType(
        params.content_type,
        params.id,
        params.site_id,
        params.include_raw_content || false
      );

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
      const input = await processWriteContent(params);
      const preparedRequest = await prepareContentWriteRequest({
        operation: 'create',
        contentType: input.content_type,
        siteId: input.site_id,
        input
      });
      const response = await makeWordPressRequest('POST', preparedRequest.endpoint, preparedRequest.data, {
        siteId: params.site_id,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });

      // Only sync when the create response carries a numeric id to target.
      const newId = response && typeof response === 'object' && typeof (response as any).id === 'number'
        ? (response as any).id
        : undefined;
      const focusKeyword = readFocusKeywordForRankMathSync(preparedRequest.data, input);
      const warnings = newId !== undefined
        ? await syncRankMathFocusKeywordWithWarnings(focusKeyword, newId, params.site_id)
        : [];

      const responseContent: any[] = [{
        type: 'text',
        text: JSON.stringify(attachWarnings(response, warnings), null, 2)
      }];
      const droppedMeta = detectDroppedMetaKeys(params.meta, response);
      if (droppedMeta.length > 0) {
        responseContent.unshift({ type: 'text', text: buildDroppedMetaWarning(droppedMeta) });
      }

      return {
        toolResult: {
          content: responseContent,
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
      const { response, warnings } = await executeContentUpdate(params);

      const responseContent: any[] = [{
        type: 'text',
        text: JSON.stringify(attachWarnings(response, warnings), null, 2)
      }];
      const droppedMeta = detectDroppedMetaKeys(params.meta, response);
      if (droppedMeta.length > 0) {
        responseContent.unshift({ type: 'text', text: buildDroppedMetaWarning(droppedMeta) });
      }

      return {
        toolResult: {
          content: responseContent,
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
      const preparedRequest = await prepareContentDeleteRequest({
        contentType: params.content_type,
        id: params.id,
        siteId: params.site_id,
        force: params.force
      });
      
      const response = await makeWordPressRequest('DELETE', preparedRequest.endpoint, preparedRequest.data, {
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
      const restSlugs = new Set(Object.keys(contentTypes));
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

      // Append contract-only types not visible in the REST API (e.g. show_in_rest = false)
      for (const { contract, manifest, executable } of resolvedContracts) {
        if (!restSlugs.has(contract.slug)) {
          formattedTypes.push({
            slug: contract.slug,
            name: contract.label || contract.slug,
            description: contract.description || `Contract-backed content type (${manifest.provider})`,
            rest_base: contract.slug,
            hierarchical: false,
            supports: [],
            taxonomies: [],
            has_extended_schema: executable,
            contract_source: manifest.source || null,
            contract_provider: manifest.provider || null,
            preferred_write_mode: contract.preferred_write_mode || null,
            interpreter_ready: executable
          });
        }
      }
      
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
      const result = await findContentByUrl(params.url, params.site_id);

      if (!result) {
        throw new Error(`No content found with URL: ${params.url}`);
      }
      
      const { content, contentType } = result;

      if (params.update_fields) {
        // Route the update through the same contract pipeline as update_content
        // (contract validation/normalization, content_edit resolution, Rank Math sync).
        const { response, warnings } = await executeContentUpdate({
          content_type: contentType,
          id: content.id,
          site_id: params.site_id,
          ...params.update_fields
        } as UpdateContentParams);

        // The write response already echoes the saved state (like update_content);
        // only re-read when include_raw_content needs the context=edit content_raw.
        const saved = params.include_raw_content
          ? await fetchContentForType(contentType, content.id, params.site_id, true)
          : response;

        const responseContent: any[] = [{
          type: 'text',
          text: JSON.stringify({
            found: true,
            content_type: contentType,
            content_id: content.id,
            original_url: params.url,
            updated: true,
            content: attachWarnings(saved, warnings),
            content_raw: params.include_raw_content ? (saved as any).content_raw : undefined
          }, null, 2)
        }];
        const droppedMeta = detectDroppedMetaKeys(params.update_fields.meta, response);
        if (droppedMeta.length > 0) {
          responseContent.unshift({ type: 'text', text: buildDroppedMetaWarning(droppedMeta) });
        }

        return {
          toolResult: {
            content: responseContent,
            isError: false
          }
        };
      }

      const responseContent = params.include_raw_content
        ? await fetchContentForType(contentType, content.id, params.site_id, true)
        : content;

      return {
        toolResult: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: true,
              content_type: contentType,
              content_id: content.id,
              original_url: params.url,
              content: responseContent,
              content_raw: params.include_raw_content ? (responseContent as any).content_raw : undefined
            }, null, 2)
          }],
          isError: false
        }
      };
    } catch (error: any) {
      const message = error instanceof ContractValidationError || error instanceof ContractCompatibilityError
        ? formatContractError(error)
        : `Error finding content by URL: ${error.message}`;

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

function applyListContentResponseFilter(
  response: unknown,
  responseFilter?: {
    eventStartAfter?: string;
    eventStartBefore?: string;
    eventStartOrder?: 'asc' | 'desc';
  }
): unknown {
  if (
    !responseFilter ||
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response)
  ) {
    return response;
  }

  const payload = response as Record<string, unknown>;
  const events = Array.isArray(payload.events) ? payload.events : undefined;

  if (!events) {
    return response;
  }

  const filteredEvents = events
    .filter((event) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return false;
      }

      const startDate = readEventStartDate(event as Record<string, unknown>);
      if (!startDate) {
        return false;
      }

      if (responseFilter.eventStartAfter && startDate < responseFilter.eventStartAfter) {
        return false;
      }

      if (responseFilter.eventStartBefore && startDate >= responseFilter.eventStartBefore) {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      const leftDate = readEventStartDate(left as Record<string, unknown>) || '';
      const rightDate = readEventStartDate(right as Record<string, unknown>) || '';
      const comparison = leftDate.localeCompare(rightDate);
      return responseFilter.eventStartOrder === 'desc' ? comparison * -1 : comparison;
    });

  return {
    ...payload,
    total: filteredEvents.length,
    page: 1,
    pages: 1,
    per_page: filteredEvents.length,
    events: filteredEvents
  };
}

function readEventStartDate(event: Record<string, unknown>): string | undefined {
  const startAt = typeof event.start_at === 'string' ? event.start_at : undefined;
  if (startAt) {
    return startAt.slice(0, 10);
  }

  const startDate = typeof event.start_date === 'string' ? event.start_date : undefined;
  return startDate;
}

// src/tools/unified-content.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeWordPressRequest, logToFile } from '../wordpress.js';
import { z } from 'zod';
import { marked } from 'marked';
import {
  applyContentEdit,
  CONTENT_EDIT_OPERATIONS,
  ContentEditOperation,
  ContentEditParams,
  isInlineContentEditTarget,
  stripSingleWrappingParagraph,
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
import { getSiteTypes } from '../content/content-types.js';
import { ContractCompatibilityError, ContractValidationError } from '../adapters/types.js';
import {
  ContentFieldsSelection,
  projectContentItem,
  projectListItem,
  projectListResponse
} from '../content/projection.js';
import {
  assertEventONWritePersistence,
  EventONWriteUnverifiedError,
  hasEventONVerifiableInput,
  isFullEventONEvent,
  formatEventONWriteUnverifiedError
} from '../content/eventon-write-verification.js';

const CACHE_DURATION = parseInt(process.env.WORDPRESS_CACHE_DURATION || `${5 * 60 * 1000}`, 10);
const rankMathActiveCache = new Map<string, { value: boolean; timestamp: number }>();

// /types lookups share the per-site cache in src/content/content-types.ts.
async function getPostTypes(forceRefresh = false, siteId?: string) {
  return getSiteTypes(siteId, forceRefresh);
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

// Derives a full-text search term from a slug (e.g. "official-clubs-week-2026"
// -> "official clubs week 2026") for endpoints that honor `search` but not `slug`.
function slugToSearchTerm(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

type ContentTypeSearchResult = { content: any; contentType: string } | null;

export interface FindContentAcrossTypesDependencies {
  // Overrides the per-type lookup (tests).
  searchType?: (contentType: string) => Promise<ContentTypeSearchResult>;
}

// Errors that mean "this type is not searchable here" rather than "the search
// failed": the type is unknown to the site, or its endpoint is missing (404).
export function isSkippableSearchError(error: any): boolean {
  if (error?.response?.status === 404) {
    return true;
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  return message.startsWith('Unknown content type') || message.startsWith('Invalid content type');
}

// Helper function to find content across multiple post types.
// Unknown or missing types are skipped. If no type could be searched at all
// because of other errors (auth, network, 5xx), throws instead of reporting
// "not found", so a failed search is not mistaken for missing content.
// Core internal types (wp_block, wp_template, wp_navigation, wp_font_face, ...)
// have no public URLs, and some use templated rest_bases that can't be listed
// directly, so URL/slug search skips them along with attachments and menu items.
export function isSlugSearchableType(type: string, definition: any): boolean {
  if (type === 'attachment' || type === 'nav_menu_item' || type.startsWith('wp_')) return false;
  const restBase = typeof definition?.rest_base === 'string' ? definition.rest_base : type;
  if (!/^[a-z0-9_-]+$/i.test(restBase)) return false;
  const namespace = definition?.rest_namespace;
  return namespace === undefined || namespace === 'wp/v2';
}

export async function findContentAcrossTypes(
  slug: string,
  contentTypes?: string[],
  siteId?: string,
  dependencies: FindContentAcrossTypesDependencies = {}
) {
  const typesToSearch = contentTypes ? [...contentTypes] : [];

  // If no specific content types provided, get all available types
  if (typesToSearch.length === 0) {
    const allTypes = await getPostTypes(false, siteId);
    const typeSet = new Set<string>(
      Object.entries(allTypes)
        .filter(([type, definition]) => isSlugSearchableType(type, definition))
        .map(([type]) => type)
    );

    // Include contract-backed types that may be missing from /types (EventON 5.x
    // exposes ajde_events with show_in_rest=true, but older or filtered installs
    // may hide it), so they are resolvable by slug/URL just like list_content
    // can enumerate them.
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

  const searchType = dependencies.searchType || (async (contentType: string): Promise<ContentTypeSearchResult> => {
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

    return null;
  });

  let searched = 0;
  const failures: string[] = [];

  const searchOne = async (contentType: string): Promise<ContentTypeSearchResult> => {
    try {
      const result = await searchType(contentType);
      searched++;
      return result;
    } catch (error: any) {
      if (isSkippableSearchError(error)) {
        logToFile(`Skipping ${contentType} in slug search: ${error?.message}`, 'debug');
      } else {
        failures.push(`${contentType}: ${error?.message || error}`);
        logToFile(`Error searching ${contentType}: ${error?.message || error}`, 'error');
      }
      return null;
    }
  };

  const assertSearchCompleted = () => {
    if (searched === 0 && failures.length > 0) {
      throw new Error(
        `Search could not be completed: every content type lookup failed (${failures.join('; ')})`
      );
    }
  };

  if (process.env.WORDPRESS_PARALLEL_SEARCH !== 'false' && typesToSearch.length > 1) {
    const results = await Promise.all(typesToSearch.map(searchOne));
    const found = results.find((result) => result !== null);
    if (found) {
      return found;
    }

    assertSearchCompleted();
    return null;
  }

  for (const contentType of typesToSearch) {
    const result = await searchOne(contentType);
    if (result) {
      return result;
    }
  }

  assertSearchCompleted();
  return null;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function hostOf(url: string): string | undefined {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

export type UrlSiteResolution =
  | { ok: true; siteId?: string; warning?: string }
  | { ok: false; error: string };

/**
 * Decide which configured site a content URL belongs to, by comparing the URL's
 * host with each site's configured URL (case-insensitive, leading "www." ignored).
 * `explicitSiteId` must already be resolved to a canonical site ID (aliases expanded).
 * - no explicit site: use the single matching site; error on several matches. On
 *   no match, proceed with a warning when exactly one site is configured (headless
 *   or CDN front ends serve a different host), otherwise error.
 * - explicit site: error if the host belongs to other configured site(s) only;
 *   proceed with a warning if the host matches no configured site.
 */
export function resolveSiteForContentUrl(
  url: string,
  explicitSiteId: string | undefined,
  sites: Array<{ id: string; url: string }>
): UrlSiteResolution {
  const host = hostOf(url);
  if (!host) {
    return { ok: false, error: `Could not parse a host from URL: ${url}` };
  }

  const matches = sites.filter((site) => hostOf(site.url) === host).map((site) => site.id);

  if (explicitSiteId) {
    if (matches.includes(explicitSiteId)) {
      return { ok: true, siteId: explicitSiteId };
    }
    if (matches.length > 0) {
      return {
        ok: false,
        error: `URL host "${host}" belongs to configured site ${matches.map((id) => `"${id}"`).join(', ')}, ` +
          `not site_id "${explicitSiteId}". Refusing to search or update the wrong site. ` +
          `Omit site_id or pass the matching one.`
      };
    }
    return {
      ok: true,
      siteId: explicitSiteId,
      warning: `URL host "${host}" does not match any configured site; searched site "${explicitSiteId}" by slug because site_id was given explicitly.`
    };
  }

  if (matches.length === 1) {
    return { ok: true, siteId: matches[0] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `URL host "${host}" matches several configured sites (${matches.join(', ')}). Pass site_id to choose one.`
    };
  }
  if (sites.length === 1) {
    return {
      ok: true,
      siteId: sites[0].id,
      warning: `URL host "${host}" does not match the configured site "${sites[0].id}" (${hostOf(sites[0].url) || sites[0].url}); ` +
        `searched it by slug because it is the only configured site.`
    };
  }
  return {
    ok: false,
    error: `URL host "${host}" does not match any configured site (${sites.map((site) => site.id).join(', ') || 'none'}). ` +
      `Pass site_id explicitly to search that site by slug anyway.`
  };
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

// Convert a content_edit value into the fragment spliced into the raw body.
// Explicit 'html' and 'blocks' are spliced verbatim for every operation. In 'auto',
// inline splices (replace/insert_before/insert_after into running text) are also
// verbatim: the full-document pipeline would wrap plain text or markdown-looking
// text in <p> and nest paragraphs. append/prepend and block-level targets in 'auto'
// go through processContent, so plain text or markdown becomes block-level HTML.
// Explicit 'markdown' always converts; for inline targets the single wrapping <p>
// that marked adds is stripped.
export async function prepareContentEditValue(edit: ContentEditParams): Promise<string> {
  const format = edit.content_format || 'auto';
  const convertToBlocks = edit.convert_to_blocks || false;

  if (format === 'markdown') {
    const converted = await processContent(edit.value, 'markdown', convertToBlocks);
    return !convertToBlocks && isInlineContentEditTarget(edit)
      ? stripSingleWrappingParagraph(converted)
      : converted;
  }

  if (format === 'auto' && !isInlineContentEditTarget(edit)) {
    return processContent(edit.value, 'auto', convertToBlocks);
  }

  return convertToBlocks && format !== 'blocks' ? convertHtmlToBlocks(edit.value) : edit.value;
}

// Resolve an update's body before the contract pipeline runs. When content_edit
// is supplied, fetch the existing raw content (contract-aware), apply the targeted
// edit, and hand the finished body to the pipeline so partial edits work uniformly
// across content types — including contract-backed ones. Otherwise fall back to the
// generic content processing used for full-document writes. `fetchRawContent` is
// injectable for tests.
export async function resolveWriteInput(
  params: UpdateContentParams,
  fetchRawContent: (contentType: string, id: number, siteId?: string) => Promise<string> = fetchEditableRawContentForType
): Promise<UpdateContentParams> {
  if (params.content_edit === undefined) {
    return processWriteContent(params);
  }

  if (params.content !== undefined) {
    throw new Error('Provide either content or content_edit, not both');
  }

  const edit = params.content_edit as ContentEditParams;
  validateContentEdit(edit);

  const existingRaw = await fetchRawContent(params.content_type, params.id, params.site_id);
  const processedFragment = await prepareContentEditValue(edit);
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

// EventON APIfy deletes always move the event to the trash. Its response
// (`{ deleted, id, title }`) has no wp/v2 `previous` snapshot, which tells it
// apart from a wp/v2 fallback that honored `force`.
export function buildDeleteWarnings(
  params: { content_type: string; force?: boolean },
  namespace: string | undefined,
  response: unknown
): string[] {
  const servedByApify =
    params.content_type === 'ajde_events' &&
    namespace === 'eventonapify/v1' &&
    Boolean(response) &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    !('previous' in (response as Record<string, unknown>));

  return params.force === true && servedByApify
    ? ['force: true was not applied: EventON APIfy moves events to the trash rather than deleting them permanently. Empty the trash in WordPress to remove the event for good.']
    : [];
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

  const writeResponse = await makeWordPressRequest('POST', itemRequest.endpoint, itemRequest.data, {
    siteId: params.site_id,
    namespace: itemRequest.namespace,
    retry404With: itemRequest.fallbackOn404
  });
  const { response, warnings: verificationWarnings } = await verifyEventONWrite('update', input, writeResponse);

  const focusKeyword = readFocusKeywordForRankMathSync(preparedRequest.data, input);
  const warnings = [
    ...verificationWarnings,
    ...(await syncRankMathFocusKeywordWithWarnings(focusKeyword, params.id, params.site_id))
  ];

  return { response, warnings };
}

// Confirm an EventON write persisted the requested fields. APIfy write responses
// already carry the persisted event, so they are checked directly; only a
// response without event fields (e.g. a wp/v2 fallback) triggers a read-back.
// The write has already happened, so a field mismatch throws
// EventONWriteUnverifiedError (carrying the written item's ID), and a failed
// read-back is only a warning.
export async function verifyEventONWrite(
  operation: 'create' | 'update',
  input: { content_type: string; site_id?: string; fields?: Record<string, unknown>; featured_media?: number },
  writeResponse: any,
  request: typeof makeWordPressRequest = makeWordPressRequest
): Promise<{ response: any; warnings: string[] }> {
  if (input.content_type !== 'ajde_events' || !hasEventONVerifiableInput(input)) {
    return { response: writeResponse, warnings: [] };
  }

  const eventId = writeResponse && typeof writeResponse === 'object' ? writeResponse.id : undefined;
  if (typeof eventId !== 'number') {
    throw new EventONWriteUnverifiedError(
      operation,
      writeResponse,
      'EventON write did not return a numeric event ID for persistence verification.'
    );
  }

  const hasStructuredFields = Boolean(input.fields && Object.keys(input.fields).length > 0);
  let persisted: unknown = writeResponse;

  if (!isFullEventONEvent(writeResponse)) {
    if (!hasStructuredFields) {
      // Generic (no-manifest) wp/v2 write: only featured_media can be checked,
      // and the wp/v2 response echoes it, so no APIfy read-back is needed.
      if ('featured_media' in writeResponse) {
        try {
          assertEventONWritePersistence(input, writeResponse);
        } catch (error: any) {
          throw new EventONWriteUnverifiedError(operation, writeResponse, error?.message ?? String(error), writeResponse);
        }
      }
      return { response: writeResponse, warnings: [] };
    }

    try {
      persisted = await request('GET', `events/${eventId}`, undefined, {
        siteId: input.site_id,
        namespace: 'eventonapify/v1'
      });
    } catch (error: any) {
      const message = `EventON write succeeded (id ${eventId}) but the verification read-back failed: ${error?.message ?? error}. ` +
        'Returned the write response unverified.';
      logToFile(message);
      return { response: writeResponse, warnings: [message] };
    }
  }

  try {
    assertEventONWritePersistence(input, persisted);
  } catch (error: any) {
    throw new EventONWriteUnverifiedError(operation, writeResponse, error?.message ?? String(error), persisted);
  }
  return { response: persisted, warnings: [] };
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
        ...preparedRequest.fallbackOn404,
        endpoint: `${preparedRequest.fallbackOn404.endpoint}/${id}`
      }
    : undefined;
  const response = await makeWordPressRequest(
    'GET',
    `${preparedRequest.endpoint}/${id}`,
    includeRawContent ? { context: 'edit' } : undefined,
    { siteId, namespace: preparedRequest.namespace, retry404With: fallbackOn404 }
  );

  return includeRawContent && response && typeof response === 'object'
    ? withContentRawAlias(response as Record<string, any>, contentType)
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

  const rawContent = readRawContentBody(response, contentType);
  if (typeof rawContent !== 'string') {
    throw new Error('Partial content edits require WordPress edit access and a REST response that includes content.raw');
  }

  return rawContent;
}

// The stored (unrendered) body of a content item. wp/v2 exposes it as
// content.raw under context=edit. EventON APIfy event reads (eventonapify/v1)
// carry no `content` object and return the raw post_content as `description`
// instead. Edited bodies are written back as `content`, which APIfy accepts as
// an alias of `description` and wp/v2 takes natively.
export function readRawContentBody(response: unknown, contentType?: string): string | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return undefined;
  }

  const item = response as Record<string, any>;
  if (typeof item.content?.raw === 'string') {
    return item.content.raw;
  }

  if (contentType === 'ajde_events' && item.content === undefined && typeof item.description === 'string') {
    return item.description;
  }

  return undefined;
}

export function withContentRawAlias<T extends Record<string, any>>(response: T, contentType?: string): T & { content_raw?: string } {
  const rawContent = readRawContentBody(response, contentType);
  if (typeof rawContent !== 'string') {
    return response;
  }

  return {
    ...response,
    content_raw: rawContent
  };
}

// Schema definitions
const listFieldsSchema = z.union([z.literal('full'), z.array(z.string())]).optional().describe(
  "Response projection, applied client-side. Default: a compact summary per item (id, slug, type, status, date, " +
  "modified, link, title, excerpt as plain text trimmed to 300 chars, author, featured_media). EventON events get " +
  "an event summary instead (start/end, timezone, event_status, event_type, tags, location and organizers reduced " +
  "to id/name/slug, repeat, flags) and RSVP attendees an attendee summary. 'full' returns the untouched WordPress response. " +
  "An array of top-level field names keeps only those keys per item. Envelope metadata (total, pages) is always kept."
);

const listContentSchema = z.object({
  content_type: z.string().describe("The content type slug (e.g., 'post', 'page', 'product', 'documentation')"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  event_id: z.number().optional().describe("Parent event ID for contract-backed nested content types such as 'event_rsvps'"),
  page: z.number().optional().describe("Page number (default 1)"),
  per_page: z.number().min(1).max(100).optional().describe("Items per page (default 10, max 100)"),
  search: z.string().optional().describe("Search term for content title or body"),
  rsvp: z.enum(['all', 'yes', 'no', 'maybe', 'waitlist']).optional().describe("RSVP filter for contract-backed attendee content types such as 'event_rsvps'"),
  slug: z.string().optional().describe("Limit result to content with a specific slug"),
  status: z.string().optional().describe("Content status (publish, draft, etc.)"),
  author: z.union([z.number(), z.array(z.number())]).optional().describe("Author ID or array of IDs"),
  categories: z.union([z.number(), z.array(z.number())]).optional().describe("Category ID or array of IDs (for posts)"),
  tags: z.union([z.number(), z.array(z.number())]).optional().describe("Tag ID or array of IDs (for posts)"),
  parent: z.number().optional().describe("Parent ID (for hierarchical content like pages)"),
  orderby: z.string().optional().describe("Sort content by parameter. For EventON ajde_events: start_at (default), created (or date), modified, or title"),
  order: z.enum(['asc', 'desc']).optional().describe("Order sort attribute"),
  after: z.string().optional().describe("ISO8601 date string to get content published after this date. For EventON ajde_events: events starting on or after this date"),
  before: z.string().optional().describe("ISO8601 date string to get content published before this date. For EventON ajde_events: events starting before this date"),
  fields: listFieldsSchema,
  refresh_cache: z.boolean().optional().describe("Force refresh the content type and manifest caches")
}).passthrough();

const getContentSchema = z.object({
  content_type: z.string().describe("The content type slug"),
  id: z.coerce.number().describe("Content ID"),
  site_id: z.string().optional().describe("Site ID (for multi-site setups)"),
  include_raw_content: z.boolean().optional().default(false).describe(
    "Fetch the content with WordPress edit context and include a top-level content_raw field for exact matching"
  ),
  fields: z.union([z.literal('full'), z.array(z.string())]).optional().describe(
    "Response projection. Default: the full item minus _links and guid. 'full' returns the untouched response. " +
    "An array of top-level field names keeps only those keys."
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
    "Content fragment to insert or use as the replacement. See content_format for when it is converted or spliced verbatim."
  ),
  target_text: z.string().optional().describe(
    "Exact raw content fragment to target for insert_before, insert_after, or replace"
  ),
  occurrence: z.number().int().positive().optional().describe(
    "Optional 1-based occurrence to target when target_text appears multiple times"
  ),
  content_format: z.enum(['auto', 'markdown', 'html', 'blocks']).optional().default('auto').describe(
    "Format of the content_edit value. 'html' and 'blocks' splice the value verbatim for every operation. " +
    "'auto' (default) splices verbatim for insert_before/insert_after/replace on inline text; for append, " +
    "prepend, or a block-level target_text it detects the format and converts plain text or markdown to " +
    "block HTML. 'markdown' always converts to HTML; for insert_before/insert_after/replace on inline text, " +
    "the single wrapping <p> is removed."
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
  content_types: z.array(z.string()).optional().describe("Content types to search in (defaults to all)"),
  fields: z.union([z.literal('full'), z.array(z.string())]).optional().describe(
    "Projection of the matched item. Default: the same compact summary as list_content (no content body; " +
    "use get_content for that). 'full' returns the untouched item; an array keeps only those top-level keys."
  )
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

const CONTRACT_DESCRIPTION_KEYS = ['fields', 'validation_rules', 'examples'];

function omitKeys<T extends Record<string, any>>(value: T, keys: string[]): Partial<T> {
  const result: Record<string, any> = { ...value };
  for (const key of keys) delete result[key];
  return result as Partial<T>;
}

export const unifiedContentTools: Tool[] = [
  {
    name: "list_content",
    description: "Lists content of any type (posts, pages, or custom post types) with filtering and pagination. " +
      "Returns compact item summaries by default (no content body); use get_content for the full item, or fields: 'full'.",
    inputSchema: { type: "object", properties: listContentSchema.shape }
  },
  {
    name: "get_content",
    description: "Gets specific content by ID and content type. Returns the full item minus _links and guid unless fields: 'full'.",
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
    description: "Searches for content by slug across one or more content types. Returns a compact summary of the match by default; use get_content for the body.",
    inputSchema: { type: "object", properties: getContentBySlugSchema.shape }
  }
];

export const unifiedContentHandlers = {
  list_content: async (params: ListContentParams) => {
    try {
      const preparedRequest = await prepareListContentRequest({
        contentType: params.content_type,
        siteId: params.site_id,
        input: params,
        refreshCache: params.refresh_cache === true
      });

      const response = await makeWordPressRequest('GET', preparedRequest.endpoint, preparedRequest.queryParams, {
        siteId: params.site_id,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });
      // Filtering, ordering and pagination are server-side; envelope totals are
      // passed through untouched. Warnings attach only to enveloped (plugin)
      // responses: a wp/v2 fallback array honors the params the warnings name.
      const projectedResponse = attachWarnings(
        projectListResponse(response, params.fields as ContentFieldsSelection | undefined),
        preparedRequest.warnings || []
      );

      return {
        toolResult: {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(projectedResponse, null, 2) 
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
            text: JSON.stringify(projectContentItem(response, params.fields), null, 2)
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
      const writeResponse = await makeWordPressRequest('POST', preparedRequest.endpoint, preparedRequest.data, {
        siteId: params.site_id,
        namespace: preparedRequest.namespace,
        retry404With: preparedRequest.fallbackOn404
      });
      const { response, warnings: verificationWarnings } = await verifyEventONWrite('create', input, writeResponse);

      // Only sync when the create response carries a numeric id to target.
      const newId = response && typeof response === 'object' && typeof (response as any).id === 'number'
        ? (response as any).id
        : undefined;
      const focusKeyword = readFocusKeywordForRankMathSync(preparedRequest.data, input);
      const warnings = [
        ...verificationWarnings,
        ...(newId !== undefined
          ? await syncRankMathFocusKeywordWithWarnings(focusKeyword, newId, params.site_id)
          : [])
      ];

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
      const message = error instanceof EventONWriteUnverifiedError
        ? formatEventONWriteUnverifiedError(error)
        : error instanceof ContractValidationError || error instanceof ContractCompatibilityError
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
      const message = error instanceof EventONWriteUnverifiedError
        ? formatEventONWriteUnverifiedError(error)
        : error instanceof ContractValidationError || error instanceof ContractCompatibilityError
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
            text: JSON.stringify(attachWarnings(response, buildDeleteWarnings(params, preparedRequest.namespace, response)), null, 2) 
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

      // Append contract-only types missing from /types (e.g. a filtered or older install with show_in_rest=false)
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
          // fields, validation_rules and examples are published once, in `description`.
          definition: contractResolution.contract ? omitKeys(contractResolution.contract, CONTRACT_DESCRIPTION_KEYS) : null,
          source: contractResolution.manifest?.source || null,
          provider: contractResolution.manifest?.provider || null,
          description: contractDescription,
          // Manifest issues are listed once, under manifest_cache.
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
      const siteResolution = resolveSiteForContentUrl(
        params.url,
        params.site_id ? siteManager.resolveSiteId(params.site_id) : undefined,
        siteManager.getAllSites()
      );
      if (!siteResolution.ok) {
        return {
          toolResult: {
            content: [{ type: 'text', text: `Error finding content by URL: ${siteResolution.error}` }],
            isError: true
          }
        };
      }
      const siteId = siteResolution.siteId;
      const siteWarnings = siteResolution.warning ? [siteResolution.warning] : [];

      const result = await findContentByUrl(params.url, siteId);

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
          site_id: siteId,
          ...params.update_fields
        } as UpdateContentParams);

        // The write response already echoes the saved state (like update_content);
        // only re-read when include_raw_content needs the context=edit content_raw.
        const saved = params.include_raw_content
          ? await fetchContentForType(contentType, content.id, siteId, true)
          : response;

        const responseContent: any[] = [{
          type: 'text',
          text: JSON.stringify({
            found: true,
            content_type: contentType,
            content_id: content.id,
            site_id: siteId,
            original_url: params.url,
            updated: true,
            warnings: siteWarnings.length > 0 ? siteWarnings : undefined,
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
        ? await fetchContentForType(contentType, content.id, siteId, true)
        : content;

      return {
        toolResult: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: true,
              content_type: contentType,
              content_id: content.id,
              site_id: siteId,
              original_url: params.url,
              warnings: siteWarnings.length > 0 ? siteWarnings : undefined,
              content: responseContent,
              content_raw: params.include_raw_content ? (responseContent as any).content_raw : undefined
            }, null, 2)
          }],
          isError: false
        }
      };
    } catch (error: any) {
      const message = error instanceof EventONWriteUnverifiedError
        ? formatEventONWriteUnverifiedError(error)
        : error instanceof ContractValidationError || error instanceof ContractCompatibilityError
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
              content: projectListItem(result.content, params.fields)
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

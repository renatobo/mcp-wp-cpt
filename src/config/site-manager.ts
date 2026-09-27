import axios, { AxiosInstance } from 'axios';
import { userAgentHeader } from './user-agent.js';
import { logToFile } from '../wordpress.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Request timeout for outbound HTTP calls, from WORDPRESS_REQUEST_TIMEOUT_MS
 * (positive integer milliseconds). Falls back to 30s on missing or invalid values
 * so one hung host cannot freeze a tool call indefinitely.
 */
export function getRequestTimeoutMs(envValue: string | undefined = process.env.WORDPRESS_REQUEST_TIMEOUT_MS): number {
  if (envValue === undefined || envValue.trim() === '') {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const trimmed = envValue.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    logToFile(`Ignoring invalid WORDPRESS_REQUEST_TIMEOUT_MS "${envValue}"; using ${DEFAULT_REQUEST_TIMEOUT_MS}ms`, 'error');
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

export interface SiteConfig {
  id: string;
  url: string;
  username: string;
  password: string;
  aliases?: string[];
  default?: boolean;
}

export class SiteManager {
  private sites = new Map<string, SiteConfig>();
  private clients = new Map<string, AxiosInstance>();
  private defaultSiteId: string | null = null;
  private initialized = false;

  constructor() {
    // Don't load sites immediately - wait for first access
  }

  /**
   * Ensure sites are loaded (lazy initialization)
   */
  private ensureInitialized() {
    if (!this.initialized) {
      this.loadSitesFromEnvironment();
      this.initialized = true;
    }
  }

  /**
   * Load site configurations from environment variables
   */
  private loadSitesFromEnvironment() {
    let sitesFound = 0;

    // Check for numbered multi-site configuration (WORDPRESS_1_URL, WORDPRESS_2_URL, etc.)
    for (let i = 1; i <= 10; i++) { // Support up to 10 sites
      const urlKey = `WORDPRESS_${i}_URL`;
      const usernameKey = `WORDPRESS_${i}_USERNAME`;
      const passwordKey = `WORDPRESS_${i}_PASSWORD`;
      const idKey = `WORDPRESS_${i}_ID`;
      const aliasesKey = `WORDPRESS_${i}_ALIASES`;
      const defaultKey = `WORDPRESS_${i}_DEFAULT`;

      if (process.env[urlKey] && process.env[usernameKey] && process.env[passwordKey]) {
        const siteConfig: SiteConfig = {
          id: process.env[idKey] || `site${i}`,
          url: process.env[urlKey]!,
          username: process.env[usernameKey]!,
          password: process.env[passwordKey]!,
          aliases: process.env[aliasesKey] ? process.env[aliasesKey]!.split(',').map(s => s.trim()) : undefined,
          default: process.env[defaultKey] === 'true' || (sitesFound === 0 && i === 1) // First site is default unless explicitly set
        };

        this.sites.set(siteConfig.id, siteConfig);
        if (siteConfig.default) {
          this.defaultSiteId = siteConfig.id;
        }
        sitesFound++;
      }
    }

    // If no numbered sites found, fall back to single-site configuration
    if (sitesFound === 0 && process.env.WORDPRESS_API_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_PASSWORD) {
      const siteConfig: SiteConfig = {
        id: 'default',
        url: process.env.WORDPRESS_API_URL,
        username: process.env.WORDPRESS_USERNAME,
        password: process.env.WORDPRESS_PASSWORD,
        default: true
      };
      this.sites.set('default', siteConfig);
      this.defaultSiteId = 'default';
      sitesFound = 1;
      logToFile('Loaded single site configuration from legacy environment variables');
    }

    if (sitesFound > 0) {
      logToFile(`Loaded ${sitesFound} WordPress site(s) from environment variables`);
      if (this.defaultSiteId) {
        logToFile(`Default site: ${this.defaultSiteId}`);
      }
    } else {
      throw new Error('No WordPress configuration found. Set WORDPRESS_1_URL, WORDPRESS_1_USERNAME, WORDPRESS_1_PASSWORD (and optionally WORDPRESS_2_*, etc.) or use legacy WORDPRESS_API_URL variables.');
    }
  }

  /**
   * Get site configuration by ID
   */
  getSite(siteId?: string): SiteConfig {
    this.ensureInitialized();
    
    const targetSiteId = siteId || this.defaultSiteId;
    if (!targetSiteId) {
      throw new Error('No site specified and no default site configured');
    }

    const site = this.sites.get(targetSiteId);
    if (!site) {
      const availableSites = Array.from(this.sites.keys()).join(', ');
      throw new Error(`Site '${targetSiteId}' not found. Available sites: ${availableSites}`);
    }

    return site;
  }

  /**
   * Get all configured sites
   */
  getAllSites(): SiteConfig[] {
    this.ensureInitialized();
    return Array.from(this.sites.values());
  }

  /**
   * Get default site ID
   */
  getDefaultSiteId(): string | null {
    this.ensureInitialized();
    return this.defaultSiteId;
  }

  /**
   * Resolve a site identifier to the canonical site ID.
   */
  resolveSiteId(siteId?: string): string {
    return this.getSite(siteId).id;
  }

  /**
   * Get the REST API root URL for a site.
   */
  getRestApiRoot(siteId?: string): string {
    const site = this.getSite(siteId);
    let baseURL = site.url.endsWith('/') ? site.url : `${site.url}/`;

    if (!baseURL.includes('/wp-json/')) {
      baseURL = `${baseURL}wp-json/`;
    } else if (!baseURL.endsWith('/')) {
      baseURL = `${baseURL}/`;
    }

    return baseURL;
  }

  /**
   * Detect site from context (domain mentions, aliases, etc.)
   */
  detectSiteFromContext(requestText: string): string | null {
    this.ensureInitialized();
    
    if (!requestText) return null;

    const lowerRequest = requestText.toLowerCase();

    // Check for domain mentions
    for (const site of this.sites.values()) {
      try {
        const hostname = new URL(site.url).hostname;
        if (lowerRequest.includes(hostname)) {
          logToFile(`Detected site '${site.id}' from domain mention: ${hostname}`);
          return site.id;
        }
      } catch (error) {
        // Invalid URL, skip
      }
    }

    // Check for alias mentions
    for (const site of this.sites.values()) {
      if (site.aliases) {
        for (const alias of site.aliases) {
          if (lowerRequest.includes(alias.toLowerCase())) {
            logToFile(`Detected site '${site.id}' from alias mention: ${alias}`);
            return site.id;
          }
        }
      }
    }

    // Check for site ID mentions
    for (const siteId of this.sites.keys()) {
      if (lowerRequest.includes(siteId.toLowerCase())) {
        logToFile(`Detected site '${siteId}' from ID mention`);
        return siteId;
      }
    }

    return null;
  }

  /**
   * Get WordPress client for a specific site
   */
  async getClient(siteId?: string, namespace: string = 'wp/v2'): Promise<AxiosInstance> {
    this.ensureInitialized();
    
    const site = this.getSite(siteId);
    const clientKey = `${site.id}:${this.normalizeNamespace(namespace)}`;
    
    if (!this.clients.has(clientKey)) {
      const client = await this.createClient(site, namespace);
      this.clients.set(clientKey, client);
    }

    return this.clients.get(clientKey)!;
  }

  /**
   * Create authenticated WordPress client for a site
   */
  private async createClient(site: SiteConfig, namespace: string = 'wp/v2'): Promise<AxiosInstance> {
    const normalizedNamespace = this.normalizeNamespace(namespace);
    const baseURL = `${this.getRestApiRoot(site.id)}${normalizedNamespace}/`;

    const auth = Buffer.from(`${site.username}:${site.password}`).toString('base64');
    
    // allowAbsoluteUrls: false keeps every request on baseURL, so an absolute URL
    // smuggled in as an endpoint cannot carry the Authorization header off-site.
    const client = axios.create({
      baseURL,
      allowAbsoluteUrls: false,
      timeout: getRequestTimeoutMs(),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        ...userAgentHeader()
      }
    });

    // Test the connection
    try {
      await client.get('');
      logToFile(`Successfully connected to site '${site.id}' namespace '${normalizedNamespace}' at ${baseURL}`);
    } catch (error: any) {
      const message = `Failed to connect to site '${site.id}' namespace '${normalizedNamespace}': ${error?.message}`;
      logToFile(message);
      // Rethrow the original AxiosError (with an augmented message) so callers
      // can still read response.status, e.g. a 404 when a plugin namespace is
      // not registered, and run their fallback or classification logic.
      if (axios.isAxiosError(error)) {
        error.message = message;
        throw error;
      }
      throw new Error(message);
    }

    return client;
  }

  /**
   * Test connection to a specific site
   */
  async testSite(siteId?: string): Promise<{ success: boolean; error?: string }> {
    this.ensureInitialized();
    
    try {
      const client = await this.getClient(siteId);
      await client.get('');
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  private normalizeNamespace(namespace: string): string {
    return namespace.replace(/^\/+|\/+$/g, '');
  }
}

// Global site manager instance
export const siteManager = new SiteManager();

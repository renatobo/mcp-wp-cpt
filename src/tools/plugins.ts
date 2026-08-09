// src/tools/plugins.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeWordPressRequest } from '../wordpress.js';
import { z } from 'zod';
import { toolError, toolSuccess } from '../mcp/tool-results.js';

const siteIdSchema = z.string().optional().describe('Site ID (for multi-site setups)');
const pluginFileSchema = z.string().min(1).describe(
  "Plugin file returned by list_plugins (for example 'akismet/akismet.php')"
);

// Note: Plugin operations require authentication with admin privileges
// and use a different endpoint than the standard WP API (wp-json/wp/v2/plugins)

// Make schema empty since the WordPress REST API plugins endpoint doesn't accept parameters
// in the same way as other endpoints
const listPluginsSchema = z.object({
  status: z.enum(['active', 'inactive']).optional().default('active').describe("Filter plugins by status (active, inactive)"),
  site_id: siteIdSchema
}).strict();

const getPluginSchema = z.object({
  plugin: pluginFileSchema,
  site_id: siteIdSchema
}).strict();

const activatePluginSchema = z.object({
  plugin: pluginFileSchema,
  site_id: siteIdSchema
}).strict();

const deactivatePluginSchema = z.object({
  plugin: pluginFileSchema,
  site_id: siteIdSchema
}).strict();

const createPluginSchema = z.object({
  slug: z.string({ error: "Plugin slug is required" }).describe("WordPress.org plugin directory slug, e.g., 'akismet', 'elementor', 'wordpress-seo'"),
  status: z.enum(['inactive', 'active']).optional().default('active').describe("Plugin activation status"),
  site_id: siteIdSchema
}).strict();

type ListPluginsParams = z.infer<typeof listPluginsSchema>;
type GetPluginParams = z.infer<typeof getPluginSchema>;
type ActivatePluginParams = z.infer<typeof activatePluginSchema>;
type DeactivatePluginParams = z.infer<typeof deactivatePluginSchema>;
type CreatePluginParams = z.infer<typeof createPluginSchema>;

export const getPluginEndpoint = (pluginFile: string): string =>
  `plugins/${encodeURIComponent(pluginFile)}`;

// Define tool set for plugin operations
export const pluginTools: Tool[] = [
  {
    name: "list_plugins",
    description: "Lists all plugins with filtering options",
    inputSchema: { type: "object", properties: listPluginsSchema.shape }
  },
  {
    name: "get_plugin",
    description: "Retrieves plugin details",
    inputSchema: { type: "object", properties: getPluginSchema.shape }
  },
  {
    name: "activate_plugin",
    description: "Activates a plugin",
    inputSchema: { type: "object", properties: activatePluginSchema.shape }
  },
  {
    name: "deactivate_plugin",
    description: "Deactivates a plugin",
    inputSchema: { type: "object", properties: deactivatePluginSchema.shape }
  },
  {
    name: "create_plugin",
    description: "Creates a plugin from the WordPress.org repository",
    inputSchema: { type: "object", properties: createPluginSchema.shape }
  }
];

// Define handlers for each plugin operation
export const pluginHandlers = {
  list_plugins: async (params: z.infer<typeof listPluginsSchema>) => {
    try {
      const { site_id, ...query } = params;
      const response = await makeWordPressRequest('GET', 'plugins', query, { siteId: site_id });
      return toolSuccess(response);
    } catch (error: unknown) {
      return toolError('listing plugins', error);
    }
  },
  get_plugin: async (params: z.infer<typeof getPluginSchema>) => {
    try {
      const response = await makeWordPressRequest('GET', getPluginEndpoint(params.plugin), undefined, { siteId: params.site_id });
      return toolSuccess(response);
    } catch (error: unknown) {
      return toolError('retrieving plugin', error);
    }
  },
  activate_plugin: async (params: z.infer<typeof activatePluginSchema>) => {
    try {
      const response = await makeWordPressRequest('POST', getPluginEndpoint(params.plugin), { status: 'active' }, { siteId: params.site_id });
      return toolSuccess(response);
    } catch (error: unknown) {
      return toolError('activating plugin', error);
    }
  },
  deactivate_plugin: async (params: z.infer<typeof deactivatePluginSchema>) => {
    try {
      const response = await makeWordPressRequest('POST', getPluginEndpoint(params.plugin), { status: 'inactive' }, { siteId: params.site_id });
      return toolSuccess(response);
    } catch (error: unknown) {
      return toolError('deactivating plugin', error);
    }
  },
  create_plugin: async (params: z.infer<typeof createPluginSchema>) => {
    try {
      const { site_id, ...data } = params;
      const response = await makeWordPressRequest('POST', 'plugins', data, { siteId: site_id });
      return toolSuccess(response);
    } catch (error: unknown) {
      return toolError('creating plugin', error);
    }
  }
};

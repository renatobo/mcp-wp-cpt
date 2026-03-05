# WordPress MCP Server

This is a Model Context Protocol (MCP) server for WordPress, allowing you to interact with your WordPress site using natural language via an MCP-compatible client like Claude for Desktop. This fork extends the base server with plugin-published content-type contracts so structured custom post types such as EventON `ajde_events` can expose machine-readable create and update guidance.

## Run Locally

This section is the recommended path if you want to run the server from this repository during development instead of using the published package.

### Prerequisites

- Node.js 18 or newer
- npm
- A WordPress site with the REST API enabled
- A WordPress user with an [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide#Getting-Credentials)
- Claude Desktop if you want to use the server through an MCP client locally

### 1. Clone the repository

```bash
git clone <repository_url>
cd mcp-wp-cpt
```

If you already cloned it under a different directory name, use that directory instead.

### 2. Install dependencies

```bash
npm install
```

This installs the runtime dependencies and the local development tools used by `npm run build`, `npm run dev`, and `npm test`.

### 3. Create a local `.env`

Create a `.env` file in the project root.

Single-site example:

```env
WORDPRESS_API_URL=https://your-wordpress-site.com
WORDPRESS_USERNAME=wp_username
WORDPRESS_PASSWORD=your_application_password
```

Multi-site example:

```env
WORDPRESS_1_URL=https://production-site.com
WORDPRESS_1_USERNAME=admin
WORDPRESS_1_PASSWORD=app_password_1
WORDPRESS_1_ID=production
WORDPRESS_1_DEFAULT=true
WORDPRESS_1_ALIASES=prod,main

WORDPRESS_2_URL=https://staging-site.com
WORDPRESS_2_USERNAME=admin
WORDPRESS_2_PASSWORD=app_password_2
WORDPRESS_2_ID=staging
WORDPRESS_2_ALIASES=stage,dev
```

Notes:

- Use either the single-site variables or the numbered multi-site variables.
- `WORDPRESS_PASSWORD` and `WORDPRESS_N_PASSWORD` should be WordPress application passwords, not your normal login password.
- If you include `/wp-json` or `/wp-json/wp/v2` in the site URL, keep it consistent. The server normalizes WordPress REST paths, but a clean site root URL is the safest input.

### 4. Build the server

```bash
npm run build
```

This compiles TypeScript into `build/`.

You should end up with:

```text
build/server.js
```

### 5. Run it directly from the terminal

For a normal local run:

```bash
npm start
```

That runs:

```bash
node ./build/server.js
```

For local development with automatic reload on source changes:

```bash
npm run dev
```

That uses `tsx watch` and is useful while editing files in `src/`.

### 6. Verify the local build before wiring it into an MCP client

Recommended checks:

```bash
npm run build
npm test
```

If startup fails immediately, the most common causes are:

- missing `.env`
- invalid WordPress URL
- invalid application password
- using the wrong username for the application password

### 7. Connect Claude Desktop to the local build

If you want Claude Desktop to use your local repository checkout instead of the published package:

1. Install [Claude Desktop](https://claude.ai/download).
2. Open Claude Desktop settings.
3. Go to the `Developer` tab.
4. Click `Edit Config`.
5. Add a local MCP server entry that points to the absolute path of `build/server.js`.
6. Save the config.
7. Restart Claude Desktop.

Start from [claude_desktop_config.json.example](./claude_desktop_config.json.example), but change the command so it runs your local build instead of `npx`.

Example local config:

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-wp-cpt/build/server.js"],
      "env": {
        "WORDPRESS_API_URL": "https://your-wordpress-site.com",
        "WORDPRESS_USERNAME": "wp_username",
        "WORDPRESS_PASSWORD": "your_application_password"
      }
    }
  }
}
```

For multi-site setups, use the numbered `WORDPRESS_N_*` environment variables in the same `env` block.

### 8. Expected local workflow

For everyday local development, this is usually enough:

1. Update `.env`
2. Run `npm install` once
3. Run `npm run build`
4. Run `npm test`
5. Start the server with `npm start` or `npm run dev`
6. Point Claude Desktop at `/absolute/path/to/mcp-wp-cpt/build/server.js`

### Running the published package instead

If you do not need local code changes, you can still run the published package with:

```bash
npx -y @instawp/mcp-wp
```

In that case, keep a `.env` file in your current working directory.

## Features

This server provides tools to interact with core WordPress data and supports **multi-site management** - manage multiple WordPress sites from a single MCP server instance.

## For Plugin Authors

If you want your plugin to publish a custom content-type contract that this server can consume, start with [PLUGIN_CONTRACT_REQUIREMENTS.md](./PLUGIN_CONTRACT_REQUIREMENTS.md).

That document defines:

- the required manifest endpoint
- the minimum contract shape
- field and validation metadata
- supported coercions and nested shapes
- what makes a contract executable by the generic interpreter

### **Multi-Site Management** (3 tools)
Manage multiple WordPress sites from a single MCP server:

*   `list_sites`: List all configured WordPress sites
*   `get_site`: Get details about a specific site configuration
*   `test_site`: Test connection to a specific WordPress site

All content and taxonomy tools support an optional `site_id` parameter to target specific sites.

### **Unified Content Management** (9 tools)
Handles ALL content types (posts, pages, custom post types) with a single set of intelligent tools:

*   `list_content`: List any content type with filtering and pagination
*   `get_content`: Get specific content by ID and type
*   `create_content`: Create new content of any type
*   `update_content`: Update existing content of any type
*   `delete_content`: Delete content of any type
*   `discover_content_types`: Find all available content types on your site
*   `describe_content_type`: Get site-specific contracts and preferred write guidance for a content type
*   `find_content_by_url`: Smart URL resolver that can find and optionally update content from any WordPress URL
*   `get_content_by_slug`: Search by slug across all content types

### **Unified Taxonomy Management** (8 tools)
Handles ALL taxonomies (categories, tags, custom taxonomies) with a single set of tools:

*   `discover_taxonomies`: Find all available taxonomies on your site
*   `list_terms`: List terms in any taxonomy
*   `get_term`: Get specific term by ID
*   `create_term`: Create new term in any taxonomy
*   `update_term`: Update existing term
*   `delete_term`: Delete term from any taxonomy
*   `assign_terms_to_content`: Assign terms to any content type
*   `get_content_terms`: Get all terms for any content

### **Specialized Tools**

*   **Media:**
    *   `list_media`: List all media items (supports pagination and searching).
    *   `get_media`: Retrieve a specific media item by ID.
    *   `create_media`: Create a new media item from a URL.
    *   `update_media`: Update an existing media item.
    *   `delete_media`: Delete a media item.
*   **Users:**
    *   `list_users`: List all users with filtering, sorting, and pagination options.
    *   `get_user`: Retrieve a specific user by ID.
    *   `create_user`: Create a new user.
    *   `update_user`: Update an existing user.
    *   `delete_user`: Delete a user.
*   **Comments:**
    *   `list_comments`: List all comments with filtering, sorting, and pagination options.
    *   `get_comment`: Retrieve a specific comment by ID.
    *   `create_comment`: Create a new comment.
    *   `update_comment`: Update an existing comment.
    *   `delete_comment`: Delete a comment.
*   **Plugins:**
    *   `list_plugins`: List all plugins installed on the site.
    *   `get_plugin`: Retrieve details about a specific plugin.
    *   `activate_plugin`: Activate a plugin.
    *   `deactivate_plugin`: Deactivate a plugin.
    *   `create_plugin`: Create a new plugin.
*   **Plugin Repository:**
    *   `search_plugins`: Search for plugins in the WordPress.org repository.
    *   `get_plugin_info`: Get detailed information about a plugin from the repository.

### **Key Advantages**

#### Smart URL Resolution
The `find_content_by_url` tool can:
- Take any WordPress URL and automatically find the corresponding content
- Detect content types from URL patterns (e.g., `/documentation/` → documentation custom post type)
- Optionally update the content in a single operation
- Works with posts, pages, and any custom post types

#### Universal Content Operations
All content operations use a single `content_type` parameter:
```json
{
  "content_type": "post",        // for blog posts
  "content_type": "page",        // for static pages  
  "content_type": "product",     // for WooCommerce products
  "content_type": "documentation" // for custom post types
}
```

#### Contract-Backed Content Types
When a plugin publishes a manifest, `discover_content_types` marks the type with:
- `has_extended_schema`
- `contract_source`
- `contract_provider`
- `preferred_write_mode`
- `interpreter_ready`

For contract-backed content types, use `describe_content_type` before writing so the MCP client can inspect the contract, field list, validation rules, execution readiness, and examples returned by the site.

The first contract exercised is EventON APIfy for `ajde_events`. Its manifest is discovered from `GET /wp-json/eventonapify/v1/mcp-schema`, while the actual content writes still go to `wp/v2/ajde_events`.

Plugin authors should follow [PLUGIN_CONTRACT_REQUIREMENTS.md](./PLUGIN_CONTRACT_REQUIREMENTS.md) when publishing a manifest for this server.

Example workflow:
1. Run `discover_content_types` to find adapted content types.
2. Run `describe_content_type` for the target type.
3. Call `create_content` or `update_content` with a structured `fields` object.

Example `create_content` payload for EventON:
```json
{
  "content_type": "ajde_events",
  "title": "Launch Party",
  "status": "draft",
  "fields": {
    "start_date": "2026-04-01",
    "start_time": "18:30",
    "end_date": "2026-04-01",
    "end_time": "20:30",
    "timezone": "America/Los_Angeles",
    "location": {
      "name": "HQ"
    },
    "organizers": [
      {
        "name": "Team"
      }
    ],
    "virtual": {
      "enabled": false
    }
  }
}
```

`custom_fields` still works for generic or legacy write flows, but `fields` is the preferred input when `describe_content_type` reports `preferred_write_mode: "fields"` and `interpreter_ready: true`.

#### Rank Math Focus Keyword Sync
When the Rank Math plugin is active, content write tools now sync `rank_math_focus_keyword` through the Rank Math API:

- `create_content`
- `update_content`
- `find_content_by_url` (when `update_fields` is provided)

The server accepts focus keyword input from multiple shapes and normalizes it before syncing:

- `meta.rank_math_focus_keyword`
- top-level `rank_math_focus_keyword`
- top-level `focus_keyword`
- `custom_fields.rank_math_focus_keyword`
- `custom_fields.focus_keyword`
- `fields.rank_math_focus_keyword`
- `fields.focus_keyword`

If the plugin is inactive, or if plugin visibility is unavailable for the current credentials, content writes still succeed and Rank Math sync is skipped.
If Rank Math sync fails after the content write, the tool response includes `_mcp_warnings` with the sync error while preserving the successful content result.

#### Universal Taxonomy Operations
All taxonomy operations use a single `taxonomy` parameter:
```json
{
  "taxonomy": "category",        // for categories
  "taxonomy": "post_tag",        // for tags
  "taxonomy": "product_category", // for WooCommerce
  "taxonomy": "skill"            // for custom taxonomies
}
```

## Configuration

### Single Site Configuration

For managing a single WordPress site, use the following environment variables:

```env
WORDPRESS_API_URL=https://your-wordpress-site.com
WORDPRESS_USERNAME=wp_username
WORDPRESS_PASSWORD=wp_app_password
```

### Multi-Site Configuration

To manage multiple WordPress sites from a single MCP server, use numbered environment variables:

```env
# Site 1 (Production)
WORDPRESS_1_URL=https://production-site.com
WORDPRESS_1_USERNAME=admin
WORDPRESS_1_PASSWORD=app_password_1
WORDPRESS_1_ID=production
WORDPRESS_1_DEFAULT=true
WORDPRESS_1_ALIASES=prod,main

# Site 2 (Staging)
WORDPRESS_2_URL=https://staging-site.com
WORDPRESS_2_USERNAME=admin
WORDPRESS_2_PASSWORD=app_password_2
WORDPRESS_2_ID=staging
WORDPRESS_2_ALIASES=stage,dev

# Site 3 (Development)
WORDPRESS_3_URL=https://dev-site.com
WORDPRESS_3_USERNAME=admin
WORDPRESS_3_PASSWORD=app_password_3
WORDPRESS_3_ID=development
```

**Multi-Site Configuration Options:**
- `WORDPRESS_N_URL`: WordPress site URL (required)
- `WORDPRESS_N_USERNAME`: WordPress username (required)
- `WORDPRESS_N_PASSWORD`: WordPress application password (required)
- `WORDPRESS_N_ID`: Site identifier (optional, defaults to `siteN`)
- `WORDPRESS_N_DEFAULT`: Set to `true` to make this the default site (optional, first site is default)
- `WORDPRESS_N_ALIASES`: Comma-separated aliases for site detection (optional)

The server supports up to 10 sites. When using multi-site configuration, all tools accept an optional `site_id` parameter to target specific sites.

Contract manifests are cached per site, so multi-site setups can safely expose different plugin contracts. Use `refresh_cache: true` on `discover_content_types` or `describe_content_type` after plugin updates.

## Development

The main local setup instructions are in [Run Locally](#run-locally).

Useful commands:

```bash
npm install
npm run build
npm run dev
npm start
npm test
npm run clean
```

## Contract Architecture

- Reads and writes remain on the standard WordPress REST API, with `wp/v2` still used as the default namespace.
- Plugin-specific discovery runs through namespace-aware requests, so the server can fetch manifest endpoints outside `wp/v2`.
- Plugin contracts are cached per site and resolved at runtime.
- `create_content` and `update_content` stay generic on the surface, but switch to contract-driven validation and normalization automatically when an executable contract exists.
- Rank Math focus keyword sync is detected per site and cached briefly to reduce plugin lookups during repeated writes.
- If a structured write is attempted without a compatible executable contract, the server returns an explicit compatibility error instead of a generic WordPress failure.

### Security

*   **Never commit your API keys or secrets to version control.**
*   **Use HTTPS for communication between the client and server.**
*   **Validate all inputs received from the client to prevent injection attacks.**
*   **Implement proper error handling and rate limiting.**

## Project Overview

### Architecture

The server uses a **unified tool architecture** to reduce complexity:

```
src/
├── server.ts                    # MCP server entry point
├── wordpress.ts                 # WordPress REST API client
├── cli.ts                      # CLI interface
├── config/
│   └── site-manager.ts         # Multi-site management
├── types/
│   └── wordpress-types.ts      # TypeScript definitions
└── tools/
    ├── index.ts                # Tool aggregation
    ├── site-management.ts      # Site management (3 tools)
    ├── unified-content.ts      # Universal content management (8 tools)
    ├── unified-taxonomies.ts   # Universal taxonomy management (8 tools)
    ├── media.ts               # Media management (~5 tools)
    ├── users.ts               # User management (~5 tools)
    ├── comments.ts            # Comment management (~5 tools)
    ├── plugins.ts             # Plugin management (~5 tools)
    └── plugin-repository.ts   # WordPress.org plugin search (~2 tools)
```

### Key Features

- **Multi-Site Support**: Manage multiple WordPress sites from a single MCP server instance
- **Smart URL Resolution**: Automatically detect content types from URLs and find corresponding content
- **Universal Content Management**: Single set of tools handles posts, pages, and custom post types
- **Universal Taxonomy Management**: Single set of tools handles categories, tags, and custom taxonomies
- **Type Safety**: Full TypeScript support with Zod schema validation
- **Comprehensive Logging**: Detailed API request/response logging for debugging
- **Error Handling**: Graceful error handling with informative messages

### Getting Started

1. Clone the repository and install dependencies with `npm install`
2. Create a `.env` file with your WordPress credentials
3. Build the project with `npm run build`
4. Configure Claude Desktop with the server
5. Start using natural language to manage your WordPress site!

### Contribution

Feel free to open issues or make pull requests to improve this project. Check out `CLAUDE.md` for detailed development guidelines.

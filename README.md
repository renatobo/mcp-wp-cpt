# WordPress MCP Server

This is a Model Context Protocol (MCP) server for WordPress, allowing you to interact with your WordPress site using natural language via an MCP-compatible client like Claude for Desktop. This fork extends the base server with plugin-published content-type contracts so structured custom post types such as EventON `ajde_events` can expose machine-readable create and update guidance.

## Run Locally

This section is the recommended path if you want to run the server from this repository during development instead of using the published package.

### Prerequisites

- Node.js 18 or newer (enough to *run* the server; **contributing** needs Node 20+ since the test tooling, Vitest 4, requires it — CI runs 20.x and 22.x)
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

### **Unified Content Management** (10 tools)

Handles ALL content types (posts, pages, custom post types) with a single set of intelligent tools:

- `list_content`: List any content type with filtering and pagination. Returns compact item summaries by default (see [Response Trimming](#response-trimming))
- `get_content`: Get specific content by ID and type
- `create_content`: Create new content of any type
- `update_content`: Update existing content of any type, including targeted partial edits
- `delete_content`: Delete content of any type
- `discover_content_types`: Find all available content types on your site
- `describe_content_type`: Get site-specific contracts and preferred write guidance for a content type
- `find_content_by_url`: Smart URL resolver that can find and optionally update content from any WordPress URL, including targeted partial edits
- `get_content_by_slug`: Search by slug across all content types
- `get_content_summary`: Return a minimal summary (id, title, slug, status, excerpt, taxonomies, word count, Yoast SEO fields) for audit and lookup workflows. Look up by `id` or `url`.

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
    *   `create_media`: Create a new media item from a URL (`source_url`) or a local file (`file_path`). See [Media Uploads](#media-uploads) for the limits on both.
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

#### Audit & Lookup Summaries

The `get_content_summary` tool returns a minimal, fixed-shape representation of a single piece of content. Designed for audit and lookup workflows where the full WP REST response — which can exceed 50KB on recipe posts because of the rendered Recipe Maker card HTML — is overkill.

**Look up by ID** (with optional `content_type`, defaulting to `post`):

```json
{
  "id": 4274,
  "content_type": "post"
}
```

**Look up by URL** (content type is detected from the URL):

```json
{
  "url": "https://example.com/blog/easy-smoked-asparagus/"
}
```

`id` and `url` are mutually exclusive — provide exactly one.

The response shape is fixed:

```json
{
  "id": 4274,
  "title": "Easy Smoked Asparagus & Hot Honey",
  "slug": "easy-smoked-asparagus",
  "status": "publish",
  "link": "https://example.com/blog/easy-smoked-asparagus/",
  "excerpt": "Smoky asparagus with hot honey.",
  "date_modified": "2026-04-30T10:14:00",
  "categories": [12, 7],
  "tags": [33],
  "featured_media": 9012,
  "word_count": 875,
  "yoast_focus_keyword": "smoked asparagus",
  "yoast_meta_title": "Easy Smoked Asparagus | Example",
  "yoast_meta_description": "Smoky charred asparagus finished with chili-lime hot honey."
}
```

Field notes:

- `title` and `excerpt` are stripped to plain text (HTML tags removed, basic entities decoded).
- `word_count` prefers `yoast_head_json.schema.@graph[].wordCount` when Yoast SEO is active; otherwise it is computed from the rendered post content with HTML stripped.
- `yoast_meta_title` and `yoast_meta_description` are read from `yoast_head_json` on the post. They are `null` when Yoast SEO is not active.
- `yoast_focus_keyword` is read from `meta._yoast_wpseo_focuskw`. WordPress core only exposes meta keys that are registered with `show_in_rest`, and Yoast SEO does not register this key by default — so this field will typically be `null` unless a companion plugin registers it (see PR #17 for context on the broader meta-key REST exposure issue).
- This tool internally bypasses the response trimming added in PR #16 so it can read `yoast_head_json`. The trim still applies to all other tools.

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

#### Targeted Content Edits

`update_content` and `find_content_by_url.update_fields` can patch the existing raw WordPress content without resending the full document.

To make exact matching easier, `get_content` and `find_content_by_url` both accept `include_raw_content: true`. When enabled, the response is fetched with WordPress edit context and includes a top-level `content_raw` field that matches what `content_edit.target_text` needs.

```json
{
  "content_type": "page",
  "id": 7,
  "include_raw_content": true
}
```

Append a short release note to the end of a post:

```json
{
  "content_type": "post",
  "id": 42,
  "content_edit": {
    "operation": "append",
    "value": "\n<p>Update: Early access is now open.</p>",
    "content_format": "html"
  }
}
```

Replace a unique HTML fragment or marker comment in place:

```json
{
  "content_type": "page",
  "id": 7,
  "content_edit": {
    "operation": "replace",
    "target_text": "<!-- pricing-card -->\n<p>Old price</p>\n<!-- /pricing-card -->",
    "value": "<!-- pricing-card -->\n<p>New price</p>\n<!-- /pricing-card -->",
    "content_format": "html"
  }
}
```

Notes:

- Rendered WordPress HTML can differ from `content.raw` because entities may be escaped and markup may be expanded, so use `include_raw_content` when you need an exact `target_text`.
- `target_text` matches the stored raw WordPress content exactly.
- If the same `target_text` appears multiple times, pass `occurrence` to choose the 1-based match.
- For posts stored as Gutenberg blocks, set `content_edit.convert_to_blocks` when inserting Markdown or HTML that should become blocks.

For contract-backed content types, use `describe_content_type` before writing so the MCP client can inspect the contract, field list, validation rules, execution readiness, and examples returned by the site.

The first contract exercised is EventON APIfy for `ajde_events`. Its manifest is discovered from `GET /wp-json/eventonapify/v1/mcp-schema`; structured creates and updates use `eventonapify/v1/events` so EventON metadata and term assignments persist transactionally.

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

The `taxonomy` parameter accepts either the taxonomy slug or its `rest_base`
(they can differ for custom taxonomies, e.g. slug `documentation_category`
with rest_base `documentation-categories`). Tools resolve the identifier via
`/wp/v2/taxonomies` and error on unknown taxonomies instead of guessing.
`assign_terms_to_content` verifies the write against the WordPress response
and reports an error if the terms were not actually saved.

#### Recipe Cards (WP Recipe Maker)

Sites running [WP Recipe Maker](https://wordpress.org/plugins/wp-recipe-maker/) (WPRM) store recipe cards in a separate `wprm_recipe` custom post type referenced by shortcode from the surrounding blog post. The unified content tools handle these recipes directly — no recipe-specific tool family is needed.

**Reading recipes**: `get_content`, `list_content`, `find_content_by_url`, and `get_content_by_slug` all work with `content_type: "wprm_recipe"`. WPRM exposes the full structured recipe payload as a `recipe` field on the REST response, including ingredients, instructions, times, equipment, nutrition, notes, and rating. `list_content` and `get_content_by_slug` return compact summaries by default, so pass `fields: ["id", "slug", "recipe"]` or `fields: "full"` to get it there.

**Writing recipes** — pass the recipe payload via `custom_fields.recipe` on `create_content` or `update_content`. WPRM hooks into the WordPress REST insert action (`rest_insert_wprm_recipe`) and reads `recipe` from the request body root, so any field documented by WPRM's data model is accepted.

> The `recipe` payload must be passed via `custom_fields` (which spreads at the request body root). The `meta` parameter nests its values under a `meta` key, which never reaches WPRM's REST hook.

Example update:

```json
{
  "content_type": "wprm_recipe",
  "id": 4274,
  "custom_fields": {
    "recipe": {
      "name": "Easy Smoked Asparagus",
      "summary": "Smoky asparagus with hot honey.",
      "servings": "4",
      "servings_unit": "people",
      "prep_time": "5",
      "cook_time": "60",
      "total_time": "65",
      "ingredients": [
        {
          "name": "",
          "ingredients": [
            { "uid": 0, "amount": "1", "unit": "Bunch", "name": "Asparagus Spears", "notes": "" },
            { "uid": 1, "amount": "1", "unit": "tbsp", "name": "Olive Oil", "notes": "" }
          ]
        }
      ],
      "instructions": [
        {
          "name": "",
          "instructions": [
            { "uid": 0, "name": "", "text": "Preheat smoker to 225°F.", "ingredients": [] },
            { "uid": 1, "name": "", "text": "Drizzle with oil, season, smoke 1 hour.", "ingredients": [] }
          ]
        }
      ],
      "notes": "Thicker spears need more time."
    }
  }
}
```

**Grouped ingredients and instructions** — recipes can split items into named groups like "For the sauce" / "For the chicken". Each entry in the outer `ingredients` (or `instructions`) array is one group with its own `name` and inner array:

```json
{
  "ingredients": [
    { "name": "For the sauce",   "ingredients": [ /* items */ ] },
    { "name": "For the chicken", "ingredients": [ /* items */ ] }
  ]
}
```

Commonly used recipe fields:

| Field           | Type            | Notes                                                |
| --------------- | --------------- | ---------------------------------------------------- |
| `name`          | string          | Recipe card title                                    |
| `summary`       | string          | Short blurb (HTML allowed)                           |
| `servings`      | string          | e.g. `"4"`                                           |
| `servings_unit` | string          | e.g. `"people"`, `"servings"`                        |
| `prep_time`     | string          | minutes, e.g. `"15"`                                 |
| `cook_time`     | string          | minutes                                              |
| `total_time`    | string          | minutes                                              |
| `ingredients`   | array of groups | nested structure shown above                         |
| `instructions`  | array of groups | nested structure shown above                         |
| `notes`         | string          | HTML allowed                                         |
| `equipment`     | array           | items shaped `{ id, name, notes, amount, uid }`      |
| `image_url`     | string          | upload-by-URL when no `image_id` is supplied         |

Course, cuisine, and keyword are stored as WPRM taxonomies (`wprm_course`, `wprm_cuisine`, `wprm_keyword`). Manage them with the unified taxonomy tools (`list_terms`, `create_term`, …) and link them to a recipe with `assign_terms_to_content`.

WPRM auto-syncs `recipe.summary` back to the WordPress `post_content` field on save. If you want the post body and the recipe summary to differ, pass `content` explicitly alongside `custom_fields.recipe`.

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

Contract manifests are cached per site, so multi-site setups can safely expose different plugin contracts. Use `refresh_cache: true` on `discover_content_types`, `describe_content_type`, or `list_content` after plugin updates.

## Using with npx and .env file

You can run this MCP server directly using npx without installing it globally:

```bash
npx -y @instawp/mcp-wp
```

Make sure you have a `.env` file in your current directory with the following variables:

```env
WORDPRESS_API_URL=https://your-wordpress-site.com
WORDPRESS_USERNAME=wp_username
WORDPRESS_PASSWORD=wp_app_password

# Optional: Custom SQL query endpoint (default: /mcp/v1/query)
WORDPRESS_SQL_ENDPOINT=/mcp/v1/query

# Optional: Comma-separated list of top-level fields to strip from
# WordPress REST API responses before they are returned to the MCP
# client. Defaults to "yoast_head,yoast_head_json" — read-only schema
# markup that adds ~10KB to every response but is rarely useful to the
# LLM. Set to an empty string to disable trimming.
MCP_WP_STRIP_FIELDS=yoast_head,yoast_head_json
```

## User Agent

Every outbound request this server makes — the WordPress REST client used by all tools, the SQL
endpoint, the two api.wordpress.org lookups, and remote media downloads — sends axios's default
`axios/<version>` user-agent.

Set `WORDPRESS_USER_AGENT` to override it everywhere:

```
WORDPRESS_USER_AGENT=MyAgency-MCP/1.0 (+https://example.com)
```

Leave it unset unless a CDN or WAF in front of your site rejects the default; an empty or
whitespace-only value is treated as unset. Avoid a bare `Mozilla/5.0` — it is a well-known bot
signature and is exactly what several edges block (see #28), which is why nothing here sends one.

## Media Uploads

`create_media` guards both of its sources:

- **`file_path`** is disabled until you set `WORDPRESS_MEDIA_UPLOAD_DIRS` to a comma-separated list
  of absolute directories. The path is resolved with `realpath`, so `..` and symlinks cannot escape
  those directories. Hidden files and dot-directories, extensionless files, and non-regular files
  are rejected.
- **`source_url`** accepts only `http`/`https`. The host must resolve to public addresses: loopback,
  private, link-local (including `169.254.169.254` cloud metadata), CGNAT, multicast, and reserved
  ranges are blocked, for IPv4, IPv6, and IPv4-mapped IPv6. Redirects are followed manually (at most
  3), re-checking each hop, and the connection is pinned to the validated address.

```env
# Directories create_media.file_path may read from (unset = local uploads disabled)
WORDPRESS_MEDIA_UPLOAD_DIRS=/Users/me/Pictures/wp-uploads,/srv/media
# Size cap for local files and downloads, in bytes (default 52428800 = 50 MB)
WORDPRESS_MEDIA_MAX_BYTES=52428800
# Timeout for source_url downloads, in ms (default 30000)
WORDPRESS_REQUEST_TIMEOUT_MS=30000
# Allow source_url to reach private/loopback addresses, e.g. a local dev site (default false)
WORDPRESS_MEDIA_ALLOW_PRIVATE_URLS=false
```

## Response Trimming

By default the server strips the top-level `yoast_head` and `yoast_head_json`
fields from every WordPress REST API response before returning it to the MCP
client. These fields contain Yoast SEO's pre-rendered schema markup, which the
LLM almost never needs but pays tokens for on every request.

- The trim applies to both single-object responses and arrays of objects.
- Only **top-level** fields are stripped; nested objects are left untouched.
- Override the list with the `MCP_WP_STRIP_FIELDS` environment variable
  (comma-separated). Set it to an empty string to disable trimming entirely.

Content reads are also projected client-side, controlled by a `fields` parameter:

- `list_content` and `get_content_by_slug` return a compact summary per item by
  default: `id`, `slug`, `type`, `status`, `date`, `modified`, `link`, `title`
  (rendered string), `excerpt` (plain text, up to 300 characters), `author`,
  `featured_media`, `parent`, `menu_order`, `categories`, `tags`. EventON events
  get an event summary instead (`start_*`/`end_*`, `timezone`, `event_status`,
  `event_type`, `tags`, `location` and `organizers` reduced to id/name/slug,
  `repeat`, `flags`, ...), and RSVP `attendees` an attendee summary. Envelope
  metadata like `total` and `pages` is kept.
- `get_content` returns the full item minus `_links` and `guid`.
- `fields: "full"` returns the untouched response; an array such as
  `fields: ["id", "content"]` keeps only those top-level keys.

## Meta field limitations

The `meta` parameter on `create_content`, `update_content`, and `find_content_by_url` (with `update_fields.meta`) forwards directly to the WordPress `/wp/v2/{type}/{id}` endpoint. WordPress core **silently drops** any meta key that has not been registered via `register_post_meta(..., ['show_in_rest' => true])`. The MCP server has no allowlist of its own — it relies on WordPress to enforce which keys persist.

This means SEO plugin keys are **not writable through this MCP server by default**, including:

- **Yoast SEO**: `_yoast_wpseo_*` (focuskw, metadesc, title, opengraph-*, twitter-*, canonical, meta-robots-*, primary_category, …)
- **Rank Math**: `rank_math_*` (title, description, focus_keyword, robots, facebook_*, twitter_*, primary_category, …)
- **All in One SEO (v4+)**: stores SEO data in a custom table (`wp_aioseo_posts`), not `wp_postmeta` — not addressable via the `meta` field by any means.

The server detects when WordPress dropped any keys you sent and prepends a `Warning:` block to the tool result listing them. This makes the silent drop visible to the LLM caller, but it cannot make WordPress accept the keys.

To enable SEO meta writes, install a small WordPress companion plugin that calls `register_post_meta` for each desired key with `show_in_rest => true` and an appropriate `auth_callback`. A separate `mcp-wp-seo-bridge` plugin is being scoped to do exactly this.

### Which keys DO work today

Plugin keys that the plugin author already registered for REST — for example Genesis layout meta (`_genesis_layout`), WP Recipe Maker fields (`wprm-*`), or ConvertKit's `_wp_convertkit_post_meta`. To check which keys round-trip on your site, write a test value via `update_content` and inspect the `meta` block in the response — if the key appears, it persisted.

The same limitation applies to term meta on `unified-taxonomies` tools (`create_term`, `update_term`).

## Enabling SQL Query Tool (Optional)

The `execute_sql_query` tool allows read-only SQL queries against your WordPress database. This optional feature requires adding a custom REST API endpoint to your WordPress site.

**Security Notes:**

- This tool only accepts read-only queries (SELECT, WITH...SELECT, EXPLAIN) for safety
- Queries containing INSERT, UPDATE, DELETE, DROP, or other modifying statements will be rejected
- Multi-statement queries are blocked to prevent SQL injection
- SELECT syntax that reaches the **filesystem of the database host** — `INTO OUTFILE`, `INTO DUMPFILE`,
  `LOAD_FILE()` — is rejected. These are valid inside a SELECT, so a "starts with SELECT" check alone
  does not stop an arbitrary file read, or a webshell being written into `wp-content/uploads`
- A query that cannot be read unambiguously is rejected rather than guessed at: an unterminated string
  or comment; a backslash-escaped quote inside a literal (whose meaning depends on the server's
  `NO_BACKSLASH_ESCAPES` sql_mode — use `''` to embed a quote instead); a MySQL `/*!` or MariaDB `/*M!`
  executable comment, whose contents the server actually runs; a NUL byte; or a function called by a
  quoted name (`` `LOAD_FILE`('/etc/passwd') `` resolves to the builtin on both engines, so the quoted
  form is refused however it is separated from its parenthesis, comments included — call functions by
  their unquoted name). One consequence worth knowing before you file it as a bug: a **quoted column
  list** is refused too, since it is a quoted token before a `(` —
  ``WITH `cte`(`a`) AS (SELECT 1) …`` and ``SELECT * FROM (SELECT 1) AS `t`(`a`)`` both have to be
  written without the quotes
- This tool requires admin-level permissions (`manage_options` capability)

**Set the database privileges. That is the boundary; the checks above are not.** Give the endpoint a
MySQL/MariaDB user with `SELECT` only and **no `FILE` privilege** (or set `secure_file_priv`), so a
query that gets past a pattern has nothing left to reach. The checks are a guard against a model —
including one under prompt injection — issuing something the tool description promised it would not;
they are pattern matching over SQL text, and pattern matching over SQL text is not a parser. Known gaps
left open on purpose: a `SELECT` can still be expensive (`SLEEP()`, `BENCHMARK()`, `GET_LOCK()`), and
neither the client nor the endpoint limits how long a query runs. (`FOR UPDATE` is refused, as a side
effect of the `UPDATE` keyword rule.)

**And the client's checks are not a boundary at all**, because anything holding the credentials can
call the REST endpoint directly. The endpoint must therefore enforce its own limits — the example below
repeats them server-side, using the same scanner. The two are kept in step by a test that extracts the
PHP from this file and drives both over one shared corpus, so a fix applied to only one of them fails
CI. They are deliberately not byte-identical in one place: `$wpdb` connects with `DB_CHARSET`, and
MySQL's "whitespace or control character" is charset-dependent (latin1 adds `0xA0`, cp850 `0xFF`), so
the PHP matches the union of those sets. The client cannot produce those bytes at all — it emits UTF-8,
where they are a syntax error.

**Logging:** nothing is logged unless you set `WORDPRESS_LOG_LEVEL=debug` (the default is `error`).
Debug output goes to **stderr**, which for a stdio MCP server the host client (Claude Desktop and
others) captures into its own log files. Credential headers such as `Authorization` and `Cookie` are
redacted, and so are credential-shaped request-body keys (`password`, `token`, `secret`, `api_key`
and their siblings) — a `create_user` call used to log the new user's password in the clear one line
below the header bag. Query text, request bodies that are not credential-shaped, and result rows are
**not** redacted, so avoid putting sensitive data in queries.

**Configuration:** By default, the tool expects the endpoint at `/mcp/v1/query`. You can customize this by setting the `WORDPRESS_SQL_ENDPOINT` environment variable (e.g., `WORDPRESS_SQL_ENDPOINT=/custom/v1/query`).

To enable this feature, add the following code to your WordPress site (via a custom plugin or your theme's `functions.php`):

```php
/**
 * Blank every string literal, quoted identifier and comment, or return null when
 * the query cannot be read unambiguously.
 *
 * A scanner rather than a list of regexes, because the order regexes run in is
 * itself a bypass: strip comments first and `SELECT '#' INTO OUTFILE '/x'` has
 * everything from the `#` onwards removed, so the INTO disappears from the text
 * you check while the server still runs it.
 *
 * This mirrors normalizeQuery() in the client's src/tools/sql-query.ts — keep the
 * two the same. Four things are refused rather than guessed at:
 *   - an unterminated literal or block comment;
 *   - a backslash before a quote, because where the literal ends then depends on
 *     the server's NO_BACKSLASH_ESCAPES sql_mode (use '' to embed a quote);
 *   - /*! ... *\/ (MySQL) and /*M! ... *\/ (MariaDB) executable comments, whose
 *     contents the server RUNS — they are not comments and cannot be stripped;
 *   - a quoted token followed by `(`, i.e. a function called by a quoted name.
 *     Both engines resolve `LOAD_FILE`('/etc/passwd') exactly as the bare
 *     builtin, so blanking the identifier would erase the keyword you are
 *     looking for. That test runs at the END, on the finished string, where
 *     comments have already become spaces — checking it inline against the raw
 *     text would only cover the separators someone thought of, and a comment is
 *     whitespace to the server.
 */
function mcp_wp_normalize_sql($query) {
    // A raw NUL cannot be told apart from the marker used below for a blanked
    // quoted token, and nothing legitimate sends one.
    if (strpos($query, "\0") !== false) {
        return null;
    }

    $out = '';
    $len = strlen($query);
    $i = 0;

    while ($i < $len) {
        $ch = $query[$i];

        if ($ch === "'" || $ch === '"' || $ch === '`') {
            $quote = $ch;
            $i++;
            $closed = false;
            while ($i < $len) {
                $c = $query[$i];
                if ($c === '\\' && $quote !== '`') {
                    $next = $i + 1 < $len ? $query[$i + 1] : '';
                    if ($next === "'" || $next === '"' || $next === '`') {
                        return null;
                    }
                    $i += 2;
                    continue;
                }
                if ($c === $quote) {
                    if ($i + 1 < $len && $query[$i + 1] === $quote) { $i += 2; continue; }
                    $i++;
                    $closed = true;
                    break;
                }
                $i++;
            }
            if (!$closed) {
                return null;
            }
            // Marked rather than blanked, so the quoted-function-name test can
            // run once at the end over the finished string.
            $out .= "\0";
            continue;
        }

        if ($ch === '/' && $i + 1 < $len && $query[$i + 1] === '*') {
            if (preg_match('/^[Mm]?!/', substr($query, $i + 2, 2))) {
                return null;
            }
            $end = strpos($query, '*/', $i + 2);
            if ($end === false) {
                return null;
            }
            $i = $end + 2;
            $out .= ' ';
            continue;
        }

        // The server starts a `--` comment on whitespace OR a control character
        // (`my_isspace || my_iscntrl`); `a--b` is arithmetic. Below 0x80 that is
        // fixed, and it is `[\x00-\x20\x7F]`.
        //
        // At or above 0x80 it is decided by character_set_client — which $wpdb
        // takes from DB_CHARSET — and the two engines do not even agree with each
        // other. The same byte can be a comment starter, an ordinary identifier
        // character, or an error, depending on both. Neither answer is safe to
        // guess: treat it as a comment and `SELECT 1--<0xA0> ... INTO OUTFILE` has
        // its whole tail blanked while the server runs it; treat it as code and
        // `\`LOAD_FILE\`--<0xA0>\n(...)` keeps text the server drops, which pushes
        // the quoted name away from its `(` and defeats the check below. Both were
        // measured, in both directions.
        //
        // So it is refused, like every other construct here that cannot be read
        // unambiguously. Nothing legitimate puts a high byte straight after `--`.
        $next = $i + 2 < $len ? $query[$i + 2] : '';

        if ($ch === '-' && $i + 1 < $len && $query[$i + 1] === '-'
            && $next !== '' && preg_match('/[\x80-\xFF]/', $next)) {
            return null;
        }

        if ($ch === '-' && $i + 1 < $len && $query[$i + 1] === '-'
            && ($next === '' || preg_match('/[\x00-\x20\x7F]/', $next))) {
            $nl = strpos($query, "\n", $i);
            $i = $nl === false ? $len : $nl;
            $out .= ' ';
            continue;
        }

        if ($ch === '#') {
            $nl = strpos($query, "\n", $i);
            $i = $nl === false ? $len : $nl;
            $out .= ' ';
            continue;
        }

        $out .= $ch;
        $i++;
    }

    // A quoted token followed by `(` is a function called by a quoted name.
    // PCRE's \s is ASCII-only, and whether a high byte separates two tokens is
    // charset-dependent — a raw 0xA0 there calls the builtin on both engines
    // under latin1 — so every high byte counts as a separator. Unlike the `--`
    // class above, widening *here* only ever rejects more, and nothing
    // legitimate puts a non-ASCII byte between an identifier and its `(`.
    if (preg_match('/\x00[\s\x80-\xFF]*\(/', $out)) {
        return null;
    }

    return str_replace("\0", ' ', $out);
}

add_action('rest_api_init', function() {
    register_rest_route('mcp/v1', '/query', array(
        'methods' => 'POST',
        'callback' => function($request) {
            global $wpdb;

            $query = $request->get_param('query');

            // Additional security check
            if (!current_user_can('manage_options')) {
                return new WP_Error('unauthorized', 'Unauthorized', array('status' => 401));
            }

            // A JSON body can send anything; without this a `{"query": []}`
            // is a PHP TypeError and a 500 rather than a 400.
            if (!is_string($query)) {
                return new WP_Error('invalid_query', 'query must be a string', array('status' => 400));
            }

            // Read-only statements only. Checked on the raw query, like the
            // client, so a leading comment stays a rejection rather than
            // becoming allowed once comments are blanked below.
            $trimmed = ltrim($query, " \t\n\r\0\x0B\f");
            if (stripos($trimmed, 'SELECT') !== 0
                && stripos($trimmed, 'WITH ') !== 0
                && stripos($trimmed, 'EXPLAIN ') !== 0) {
                return new WP_Error('invalid_query', 'Only read-only queries (SELECT, WITH...SELECT, EXPLAIN) are allowed', array('status' => 400));
            }

            // Do not trust the caller's validation. Every check below runs against
            // the normalized query, so a keyword inside a literal is not a false
            // positive and one split by a comment is not a bypass (the server
            // treats a comment as whitespace).
            $normalized = mcp_wp_normalize_sql($query);

            if (!is_string($normalized)) {
                return new WP_Error('invalid_query', 'Query could not be validated', array('status' => 400));
            }

            // One statement only.
            if (preg_match('/;\s*\S/', $normalized)) {
                return new WP_Error('invalid_query', 'Only one statement is allowed', array('status' => 400));
            }

            // INTO OUTFILE / INTO DUMPFILE write a file on the database host and
            // LOAD_FILE() reads one; all three are valid SELECT syntax.
            if (preg_match('/\b(INTO|LOAD_FILE)\b/i', $normalized)) {
                return new WP_Error('invalid_query', 'Filesystem access is not allowed', array('status' => 400));
            }

            if (preg_match('/\b(DROP|DELETE|UPDATE|ALTER|CREATE|GRANT|REVOKE)\b/i', $normalized)) {
                return new WP_Error('invalid_query', 'Only read-only queries are allowed', array('status' => 400));
            }

            // INSERT(), TRUNCATE() and REPLACE() are also ordinary read-only
            // functions, so these three only count when no `(` follows.
            if (preg_match('/\b(INSERT|TRUNCATE|REPLACE)\b(?!\s*\()/i', $normalized)) {
                return new WP_Error('invalid_query', 'Only read-only queries are allowed', array('status' => 400));
            }

            $results = $wpdb->get_results($query, ARRAY_A);

            if ($wpdb->last_error) {
                return new WP_Error('query_error', $wpdb->last_error, array('status' => 400));
            }

            return array(
                'results' => $results,
                'num_rows' => count($results)
            );
        },
        'permission_callback' => function() {
            return current_user_can('manage_options');
        }
    ));
});
```

After adding this code, you can use the `execute_sql_query` tool to run queries like:

```sql
SELECT * FROM wp_posts WHERE post_type = 'post' AND post_status = 'publish' LIMIT 10
```

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

### Running Tests

The repo runs two suites and `npm test` executes both:

- [Vitest](https://vitest.dev/) tests under `tests/` cover the multi-site `SiteManager` and the MCP tool registry wiring.
- A `node:test` suite under `test/` covers contract manifest caching, payload shaping, and EventON read/write preparation.

### WordPress 7 least-privilege integration gate

The live WordPress 7 suite is disabled unless explicitly enabled. Use a disposable
WordPress 7.x test site and an Author-level user with a dedicated Application
Password; do not use an administrator account or production site.

```bash
RUN_WORDPRESS_7_INTEGRATION=true \
WORDPRESS_7_TEST_URL=https://wp7-test.example.com \
WORDPRESS_7_TEST_USERNAME=mcp-integration-author \
WORDPRESS_7_TEST_PASSWORD=xxxx-xxxx-xxxx-xxxx \
npm test
```

The suite verifies that the target reports WordPress 7.x, exercises a draft-post
create/read/update/trash lifecycle, cleans up the test post, and confirms that the
account cannot administer plugins or enumerate users. Credentials must only be
provided through the environment and must never be committed.

The plugin-specific WPRM round-trip suite is also opt-in. Set
`RUN_WPRM_INTEGRATION=true` together with the ordinary `WORDPRESS_API_URL`,
`WORDPRESS_USERNAME`, and `WORDPRESS_PASSWORD` variables to run it against a
disposable site with WP Recipe Maker installed.

```bash
npm test            # one-shot run (vitest + node:test)
npm run test:watch  # vitest watch mode
```

Tests run on `pull_request` and on pushes to `main` via `.github/workflows/test.yml`.

### Releasing

Merging a fix does not reach anyone — npm keeps serving the last published version until a release
runs. Publishing is automated by `.github/workflows/release.yml`, triggered by a version tag:

```bash
# on main, with the fix already merged:
# 1. move the CHANGELOG's [Unreleased] block under a `[x.y.z] - <date>` heading and commit it
# 2. bump and tag — `npm version` writes package.json, commits, and creates the vx.y.z tag
npm version patch          # or minor / major
# 3. push the commit and the tag; the tag is what triggers the publish
git push origin main --follow-tags
```

Do the CHANGELOG edit *before* `npm version`. Amending the commit afterwards leaves the tag pointing
at the pre-amend commit, and the workflow would publish from that.

The workflow refuses to publish if the tag and `package.json` disagree, or if that version is
already on npm; it then builds, runs the tests, publishes with
[provenance](https://docs.npmjs.com/generating-provenance-statements), and confirms the registry
actually serves the new version before reporting success.

If a tag exists but the publish failed (or predates this workflow), re-run it from
**Actions → Release → Run workflow**, leaving the branch selector on `main` (that is where the
workflow file is read from) and passing the tag name in the input. Two caveats: the tag's tree must
already contain the `repository` field described below, and the provenance attestation records the
ref the workflow was *dispatched from*, not the tag — so for a real release, prefer re-cutting a
version and using the tag-push path.

If the publish succeeds but the verification step goes red (a registry that stayed slow for more
than two minutes), check npmjs.com before doing anything: the version is published, and re-running
will now fail the already-on-npm guard by design. Nothing needs fixing in that case.

**Setup, once:** the workflow needs an npm automation token with publish rights on the `@instawp`
scope, stored as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions). An
*automation* token specifically — a classic publish token fails in CI on a 2FA-enforced account.

npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) would remove the stored token
entirely, but it needs npm ≥ 11.5.1 and `setup-node` currently ships npm 10.x with Node 22, so it is
not usable here without also upgrading npm inside the job.

Publishing with provenance requires the `repository` field in `package.json` to match this repo — the
registry rejects the publish otherwise. Don't remove it.

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
    ├── unified-content.ts      # Universal content management (9 tools)
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

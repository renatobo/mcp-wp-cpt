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

### **Unified Content Management** (10 tools)

Handles ALL content types (posts, pages, custom post types) with a single set of intelligent tools:

- `list_content`: List any content type with filtering and pagination
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

The `taxonomy` parameter accepts either the taxonomy slug or its `rest_base`
(they can differ for custom taxonomies, e.g. slug `documentation_category`
with rest_base `documentation-categories`). Tools resolve the identifier via
`/wp/v2/taxonomies` and error on unknown taxonomies instead of guessing.
`assign_terms_to_content` verifies the write against the WordPress response
and reports an error if the terms were not actually saved.

#### Recipe Cards (WP Recipe Maker)

Sites running [WP Recipe Maker](https://wordpress.org/plugins/wp-recipe-maker/) (WPRM) store recipe cards in a separate `wprm_recipe` custom post type referenced by shortcode from the surrounding blog post. The unified content tools handle these recipes directly — no recipe-specific tool family is needed.

**Reading recipes** — `get_content`, `list_content`, `find_content_by_url`, and `get_content_by_slug` all work with `content_type: "wprm_recipe"`. WPRM exposes the full structured recipe payload as a `recipe` field on the REST response, including ingredients, instructions, times, equipment, nutrition, notes, and rating.

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

Contract manifests are cached per site, so multi-site setups can safely expose different plugin contracts. Use `refresh_cache: true` on `discover_content_types` or `describe_content_type` after plugin updates.

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

## Response Trimming

By default the server strips the top-level `yoast_head` and `yoast_head_json`
fields from every WordPress REST API response before returning it to the MCP
client. These fields contain Yoast SEO's pre-rendered schema markup, which the
LLM almost never needs but pays tokens for on every request.

- The trim applies to both single-object responses and arrays of objects.
- Only **top-level** fields are stripped; nested objects are left untouched.
- Override the list with the `MCP_WP_STRIP_FIELDS` environment variable
  (comma-separated). Set it to an empty string to disable trimming entirely.

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

- This tool only accepts read-only queries (`SELECT`, `WITH...SELECT`, `EXPLAIN`)
- Queries containing `INSERT`, `UPDATE`, `DELETE`, `DROP`, or other modifying statements are rejected
- Multi-statement queries are blocked to reduce SQL injection risk
- Queries and results may be logged, so avoid sensitive data in queries
- This tool requires admin-level permissions (`manage_options` capability)

By default, the tool expects the endpoint at `/mcp/v1/query`. You can customize it with `WORDPRESS_SQL_ENDPOINT`.

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

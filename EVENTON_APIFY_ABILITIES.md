# EventON APIfy WordPress abilities

EventON APIfy 3.5.0 (released 2026-09-26, requires WordPress 7.1) registers three read-only WordPress abilities. This server does not use them yet: it reads EventON through the plugin's `mcp-schema` manifest and writes through `wp/v2` (see [PLUGIN_CONTRACT_REQUIREMENTS.md](PLUGIN_CONTRACT_REQUIREMENTS.md)). This note records what the abilities offer and what adopting them would involve. Nothing here is implemented in this repo.

Source of truth: `eventon-apify/includes/abilities.php` and the "WordPress abilities" section of the eventon-apify README.

## What is available

| Ability | Input | Returns |
| --- | --- | --- |
| `eventon-apify/get-status` | none | `plugin_version`, `eventon_available`, `eventon_rsvp_available`, `custom_event_api_enabled`, `wp_v2_compatibility_enabled`, and `custom_event_api_capabilities` (one boolean per operation toggle: `list`, `read`, `create`, `update`, `delete`, `rsvp_counts`, `rsvp_attendees`). Works while the API is disabled; returns no event data. |
| `eventon-apify/search-events` | `search` (≤200 chars), `page` (≥1), `per_page` (1-100), `status` (array of `publish`, `draft`, `private`, `pending`, `future`), `starts_on_or_after`, `starts_before` (date or ISO 8601), `upcoming` (bool), `order` (`asc`/`desc`), `orderby` (`start_at`, `created`, `modified`, `title`). No other keys allowed. | `total`, `pages`, `page`, `per_page`, optional `truncated: true`, and `events[]` summaries: `id`, `title`, `slug`, `status`, `link`, `start_at`, `end_at`, `timezone` (IANA id), `event_status`, `attendance_mode`, `location_name`, `event_type` (labels). |
| `eventon-apify/get-event` | `id` (integer ≥1, required) | One event in the `eventonapify/v1` event shape, with location/organizer email, phone, and address, virtual access secrets (URL, password, embed), and RSVP notification emails removed. |

All three are in the `eventon-apify` category and annotated `readonly: true, destructive: false, idempotent: true`. There are no write abilities; writes stay on `wp/v2` (and `eventonapify/v1`).

## Calling them over REST

Core exposes abilities under `/wp-json/wp-abilities/v1`. Use the same Application Password Basic auth this server already sends.

- List: `GET /wp-json/wp-abilities/v1/abilities`, paginated with `page` / `per_page` and filterable with `category=eventon-apify` or `namespace=eventon-apify`. Each entry includes `name`, `label`, `description`, `category`, `input_schema`, `output_schema`, and `meta`. Core has already run the schemas through `wp_prepare_json_schema_for_client()`, so they are client-ready JSON Schema (draft-04 profile).
- Describe one: `GET /wp-json/wp-abilities/v1/abilities/eventon-apify/search-events`
- Run: `GET /wp-json/wp-abilities/v1/abilities/<name>/run`. Read-only abilities must be run with `GET`; core rejects `POST` for them. Input goes in the `input` query parameter, for example `...?input[search]=ride&input[per_page]=10` or `...get-event/run?input[id]=123`. Core coerces query-string scalars to the schema types.

## Authorization and errors

- Execution requires `manage_options`, same as every `eventonapify/v1` route. The Author-level account the WordPress 7 integration TODO mentions will be denied.
- Non-administrators cannot discover them either: they are filtered out of the abilities list, and their single-ability routes return 401/403. An empty list therefore means "not an administrator" or "plugin older than 3.5.0 / WordPress older than 7.1", not necessarily "not installed".
- Each event ability runs the matching `eventonapify/v1` route in-process, so errors carry the route's codes and statuses unchanged: `eventon_apify_disabled` (403, API master switch off), `eventon_apify_capability_disabled` (403, the List events / Read single event toggle off), `eventon_apify_eventon_missing` (503), `eventon_apify_not_found` (404).
- Core's own errors: `ability_invalid_input` (400, input outside the schema, including unknown keys and `per_page` > 100), `rest_ability_cannot_execute` (403 over REST), `ability_invalid_permissions` (in-process).

## If this server adopts them

Possible uses, roughly in order of value:

1. **Health check before EventON operations.** `get-status` answers "is EventON active, is the API on, which operations are allowed" in one call without touching event data. Today the server infers this from the manifest's availability flags. This would give clearer errors when a site has the API or a toggle switched off.
2. **Event lookup.** `search-events` returns compact summaries with correct timezone offsets (EventON stores wall-clock time as UTC; the plugin converts it), which is cheaper for an LLM than full `wp/v2` event payloads.
3. **Generic ability tools.** A generic "list abilities / run ability" pair of tools would cover these three and any other plugin's abilities, using the published schemas as tool input schemas. That fits this repo's contract-driven approach better than EventON-specific tools.

Things to keep:

- Keep the manifest path and the `wp/v2` write path. The abilities are read-only and do not replace the contract interpreter; the manifest's field vocabulary (`write_key`, `aliases`, `required_on`, `shape`) is not JSON Schema and is not published as abilities.
- Feature-detect: a site on EventON APIfy < 3.5.0 or WordPress < 7.1 has no abilities. Fall back to the current behavior when `wp-abilities/v1` is absent or the list contains no `eventon-apify/*` entries.
- `get-event` output is redacted. Do not rely on it for contact fields the manifest-driven read currently returns to administrators.

## Verified

Against WordPress 7.1.2 with EventON 5.0.13.1 (Docker, 2026-09-26), and in eventon-apify's CI integration job on WordPress 7.1.2: ability results match the REST routes, schema-invalid input is rejected, the toggles and master switch apply, administrators list and run the abilities over `/wp-abilities/v1`, and subscribers are denied both discovery and execution. Not verified: any MCP client consuming them, including this server.

# AGENTS.md

## Repo Workflow

- Install dependencies with `npm install`.
- Build the server with `npm run build`.
- Run the compiled server with `npm start`.
- Use `npm run dev` for source editing with `tsx watch`.
- Run the test suite with `npm test`.

## Environment

- Use a local `.env` for WordPress credentials.
- The README documents both single-site `WORDPRESS_API_URL` / `WORDPRESS_USERNAME` / `WORDPRESS_PASSWORD` and multi-site `WORDPRESS_N_*` variables.
- `WORDPRESS_PASSWORD` values should be WordPress Application Passwords, not normal login passwords.

## Manual Verification

- `scripts/manual-test-meta-warning.mjs` is the repo's documented end-to-end manual test for dropped-meta-key warnings.
- TODO: add more manual test scripts here if the repo grows additional documented end-to-end checks.

# Repository Guidelines

## Ownership

Squad Intents + Solver. Reviewer: Alexander (`@reednaa`).

## Project Structure & Module Organization

- `src/routes/` contains SvelteKit routes; the primary UI is `src/routes/+page.svelte`.
- `src/lib/screens/` holds the scrollable “screen” components used by the main page.
- `src/lib/components/`, `src/lib/utils/`, and `src/lib/state.svelte.ts` contain shared UI, helpers, and state.
- `src/lib/libraries/` wraps external endpoints and integrations.
- `src/lib/db.ts`, `src/lib/schema.ts`, and `drizzle/` define and store database schema + migrations.
- `src/app.css`, `src/app.html`, and `src/app.d.ts` are global app assets/config.

## Build, Test, and Development Commands

Use `bun` for all workflows.

- `bun install` installs dependencies.
- `bun run dev` starts the Vite dev server.
- `bun run build` generates a production build.
- `bun run preview` serves the production build locally.
- `bun run check` runs `svelte-check` with the repo’s TS config.
- `bun run lint` checks formatting (oxfmt) and lint rules (oxlint); `bun run lint:fix` applies oxlint fixes.
- `bun run format` auto-formats the repo with oxfmt (`bun run format:check` to verify).
- `bun run migrate` generates Drizzle migrations and compiles them.

## Coding Style & Naming Conventions

- Formatting is enforced by oxfmt (including `.svelte` files and Tailwind class sorting); run `bun run format`.
- Linting uses oxlint (lints `<script>` blocks in `.svelte` files; no Svelte template rules); run `bun run lint`.
- Prefer descriptive component names in `src/lib/screens/` and keep route files minimal.
- Use TypeScript where applicable (`.ts`, `.svelte` with `lang="ts"`).

## Testing Guidelines

- `bun run test:unit` runs bun test on `tests/unit/` and `tests/db.test.ts`; fixtures live in `tests/fixtures/`.
- `bun run test:e2e` runs Playwright on `tests/e2e/` against a local `vite dev`. The live specs skip unless `E2E_PRIVATE_KEY` is set (see `.env.e2e.example`).
- CI (`.github/workflows/test.yml`) runs `check`, `test:unit` and `test:e2e`; run `bun run check` and `bun run lint` before pushing.

## Commit & Pull Request Guidelines

- Commit messages are short, imperative, and capitalized (e.g., “Fix websockets”, “Add new chains”).
- PRs should include a concise description, testing performed (commands run), and UI screenshots for visual changes.
- Link relevant issues or context when available.

## Configuration & Environment

- Copy `.env.example` to `.env` and fill required keys (WalletConnect + Polymer).
- Cloudflare Workers are the default deployment target; see `svelte.config.js` and `wrangler.toml`.

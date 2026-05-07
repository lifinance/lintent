# Repository Guidelines

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
- `bun run lint` checks formatting (Prettier) and lint rules (ESLint).
- `bun run format` auto-formats the repo with Prettier.
- `bun run migrate` generates Drizzle migrations and compiles them.

## Coding Style & Naming Conventions

- Formatting is enforced by Prettier and `prettier-plugin-svelte`; run `bun run format`.
- Linting uses ESLint with Svelte support; run `bun run lint`.
- Prefer descriptive component names in `src/lib/screens/` and keep route files minimal.
- Use TypeScript where applicable (`.ts`, `.svelte` with `lang="ts"`).

## Testing Guidelines

- There is no dedicated test framework in this repo.
- Use `bun run check` and `bun run lint` as the baseline quality gate.
- If you add tests, keep them near the feature and name them clearly (e.g. `*.test.ts`).

## Commit & Pull Request Guidelines

- Commit messages are short, imperative, and capitalized (e.g., “Fix websockets”, “Add new chains”).
- PRs should include a concise description, testing performed (commands run), and UI screenshots for visual changes.
- Link relevant issues or context when available.

## Configuration & Environment

- Copy `.env.example` to `.env` and fill required keys (WalletConnect + Polymer).
- Cloudflare Workers are the default deployment target; see `svelte.config.js` and `wrangler.jsonc`.

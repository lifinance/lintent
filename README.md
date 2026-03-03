# LI.FI Intent Demo

The LI.FI intent demo is hosted at lintent.org. It demonstrates the entire intent flow from resource lock mangement, intent issuance, and solving intents.

## Project

This project uses SvelteKit and `bun`. It is configured for a deployment to Cloudflare workers, to change the deployment target modify [/svelte.config.js](/svelte.config.js) with another [adapter](https://svelte.dev/docs/kit/adapters).

### Development

To start development:

1. Copy `.env.example` to `.env`.
2. Then fill in the `env` variables by creating a [WalletConnect](https://walletconnect.com) project
3. Also create an [account](https://accounts.polymerlabs.org/) with Polymer to generation [Polymer](https://polymerlabs.org) API keys.
4. Install dependencies `bun install`.
5. Start `bun run dev`.

### Testing

The project now uses a two-layer automated test suite:

1. Unit and integration tests with `bun test`
2. Browser UI-state tests with Playwright

Run:

- `bun run test:unit` for library/unit/integration tests with coverage output
- `bun run test:e2e` for live browser + chain escrow flow tests
- `bun run test:all` to run both

For local Playwright setup:

1. `bun install`
2. `bunx playwright install chromium`
3. Copy `.env.e2e.example` to `.env.e2e` and set `E2E_PRIVATE_KEY`.
4. Ensure the E2E wallet has mainnet gas + tiny USDC balances on Base and Arbitrum.
5. Start E2E with `bun run test:e2e`.
6. If `E2E_PRIVATE_KEY` is not defined, private-key E2E specs are skipped.

## Structure

Lintent is built around a single page [/src/routes/+page.svelte](/src/routes/+page.svelte).

The app consists of a series of screens that are displayed in a scrollable container. Each screen can be found in [/src/lib/screens/](/src/lib/screens/).

### Libraries

Several helper classes that acts as wrappers for external endpoints can be found in [/src/lib/libraries/](/src/lib/libraries/).

## License

This project is licensed under the **[MIT License](/LICENSE)**. Any contributions to this repository is provided with a MIT License.

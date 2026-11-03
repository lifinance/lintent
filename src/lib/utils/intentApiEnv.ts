/**
 * Resolves the Intent API toggle (Default / Staging / Production) to the
 * `IntentApi(production)` flag. Every caller — quotes, order submission, the
 * order list and its websocket — must go through this so they all hit the same
 * backend. Production serves testnet orders too, so Default means production
 * on both networks; an explicit choice always wins, for every route.
 */
export function resolveProductionApi(choice: boolean | null | undefined): boolean {
  return choice ?? true;
}

import { isAddress } from "viem";
import { DEMO_EXCLUSIVE_SOLVER } from "$lib/config";

export type DemoQuoteParams = {
  /** Solver addresses to request exclusivity for, or undefined for none. */
  exclusiveFor: `0x${string}`[] | undefined;
  /** Integrator key to send as the X-Integrator-Key header, or undefined. */
  integratorKey: string | undefined;
};

const toRawAddress = (value: string): `0x${string}` | undefined =>
  isAddress(value, { strict: false }) ? (value as `0x${string}`) : undefined;

/**
 * Resolves the exclusivity and integrator-key parameters for a quote request.
 *
 * In 1:1 demo mode the order is forced exclusive to the LI.FI demo solver (so it
 * fills 1:1 via the solver's quick fallback) and the integrator key is sent as a
 * header. Outside demo mode, behavior follows the manual "Lock Exclusive" field.
 */
export function resolveDemoQuoteParams(opts: {
  use11Demo: boolean;
  integratorKey: string;
  useExclusiveForQuoteRequest: boolean;
  exclusiveFor: string;
}): DemoQuoteParams {
  if (opts.use11Demo) {
    return {
      exclusiveFor: [DEMO_EXCLUSIVE_SOLVER],
      integratorKey: opts.integratorKey ? opts.integratorKey : undefined
    };
  }

  const exclusiveFor = opts.useExclusiveForQuoteRequest
    ? [toRawAddress(opts.exclusiveFor)].filter(
        (value): value is `0x${string}` => value !== undefined
      )
    : undefined;

  return { exclusiveFor, integratorKey: undefined };
}

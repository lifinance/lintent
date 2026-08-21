import { resolveAddressForChainType } from "$lib/utils/address";
import type { ChainType } from "$lib/utils/chainType";

export type DemoQuoteParams = {
  /** Solver addresses to request exclusivity for, or undefined for none. */
  exclusiveFor: `0x${string}`[] | undefined;
  /** Integrator key to send as the X-Integrator-Key header, or undefined. */
  integratorKey: string | undefined;
};

/**
 * Resolves the exclusivity and integrator-key parameters for a quote request.
 *
 * In 1:1 demo mode the integrator key is sent as a header and `exclusiveFor` is
 * never set, so the request carries no `metadata.exclusiveFor` (the integrator
 * key alone drives the 1:1 quote). Outside demo mode, behavior follows the manual
 * "Lock Exclusive" field.
 *
 * The solver is resolved against the INPUT chain type, not chain-agnostically:
 * the order service normalizes `metadata.exclusiveFor` against the quote's
 * origin chain, so an EVM address on a Solana-origin request matches nothing,
 * and a Solana key on an EVM-origin request is not an address the input settler
 * could ever pay out to. Resolution yields the app's internal hex form (20
 * bytes for EVM/Tron, 32 for Solana); `@lifi/intent` re-encodes it for the wire
 * from the input namespace, exactly as it does for every other address field.
 */
export function resolveDemoQuoteParams(opts: {
  use11Demo: boolean;
  integratorKey: string;
  useExclusiveForQuoteRequest: boolean;
  exclusiveFor: string;
  inputChainType: ChainType;
}): DemoQuoteParams {
  if (opts.use11Demo) {
    return {
      exclusiveFor: undefined,
      integratorKey: opts.integratorKey ? opts.integratorKey : undefined
    };
  }

  const resolved = resolveAddressForChainType(opts.exclusiveFor, opts.inputChainType);
  const exclusiveFor = opts.useExclusiveForQuoteRequest
    ? [resolved].filter((value): value is `0x${string}` => value !== undefined)
    : undefined;

  return { exclusiveFor, integratorKey: undefined };
}

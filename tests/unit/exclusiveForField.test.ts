import { describe, expect, it } from "bun:test";
import { addressToBytes32 } from "@lifi/intent";
import { isBytes32ForChainType, resolveAddressForChainType } from "../../src/lib/utils/address";

// The solver identity that stranded order
// 0x2947daf76e839afdd36972307f937d2dd80bea17c264f242b6fc78697168dcd3: a
// Solana-origin order carrying a zero-padded EVM address as exclusiveFor. The
// EVM fill succeeded; `finalise` on Solana can never succeed, because the
// escrow pays out only to the signer named in the fill.
const EVM_SOLVER = "0x7bb2b9b2cf209b88850cb744d9e38297905549c9";
const EVM_SOLVER_PADDED = "0x0000000000000000000000007bb2b9b2cf209b88850cb744d9e38297905549c9";
const TRON_SOLVER = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// Any valid 32-byte base58 key; bytes pinned rather than shape-matched so a
// byte-reversed or otherwise wrong decode fails loudly.
const SOLANA_SOLVER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_SOLVER_B32 = "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";

describe("isBytes32ForChainType", () => {
  it("accepts a zero-padded 20-byte address for EVM and Tron", () => {
    expect(isBytes32ForChainType(EVM_SOLVER_PADDED, "evm")).toBe(true);
    expect(isBytes32ForChainType(EVM_SOLVER_PADDED, "tron")).toBe(true);
  });

  it("rejects a zero-padded 20-byte address for Solana — nobody can sign with that key", () => {
    expect(isBytes32ForChainType(EVM_SOLVER_PADDED, "solana")).toBe(false);
  });

  it("accepts a 32-byte key for Solana and rejects it for EVM and Tron", () => {
    expect(isBytes32ForChainType(SOLANA_SOLVER_B32, "solana")).toBe(true);
    expect(isBytes32ForChainType(SOLANA_SOLVER_B32, "evm")).toBe(false);
    expect(isBytes32ForChainType(SOLANA_SOLVER_B32, "tron")).toBe(false);
  });

  it("rejects anything that is not 32 bytes of hex", () => {
    for (const chainType of ["evm", "tron", "solana"] as const) {
      expect(isBytes32ForChainType(EVM_SOLVER, chainType)).toBe(false);
      expect(isBytes32ForChainType("0x", chainType)).toBe(false);
      expect(isBytes32ForChainType(`0x${"z".repeat(64)}` as `0x${string}`, chainType)).toBe(false);
    }
  });

  it("accepts the zero address for EVM and rejects it for Solana", () => {
    // The all-zero value is EVM-shaped by construction. It is not a solver
    // anyone would set, but the shape answer must stay consistent.
    const zero = `0x${"0".repeat(64)}` as `0x${string}`;
    expect(isBytes32ForChainType(zero, "evm")).toBe(true);
    expect(isBytes32ForChainType(zero, "solana")).toBe(false);
  });
});

describe("exclusiveFor resolved against the input chain", () => {
  it("rejects an EVM solver on a Solana-origin order — the reported failure", () => {
    expect(resolveAddressForChainType(EVM_SOLVER, "solana")).toBeUndefined();
    expect(resolveAddressForChainType(TRON_SOLVER, "solana")).toBeUndefined();
  });

  it("resolves a base58 solver for a Solana-origin order to its 32-byte form", () => {
    expect(resolveAddressForChainType(SOLANA_SOLVER, "solana")).toBe(SOLANA_SOLVER_B32);
  });

  it("keeps EVM and Tron origins working as before", () => {
    expect(resolveAddressForChainType(EVM_SOLVER, "evm")).toBe(EVM_SOLVER);
    expect(resolveAddressForChainType(TRON_SOLVER, "tron")).toBe(
      "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"
    );
    expect(resolveAddressForChainType(SOLANA_SOLVER, "evm")).toBeUndefined();
  });

  // Regression vector for the exact byte pattern that stranded the order: an
  // EVM address reaching a Solana-origin context through padding.
  it("never produces a padded EVM address for a Solana-origin context", () => {
    const resolved = resolveAddressForChainType(EVM_SOLVER, "solana");
    expect(resolved).toBeUndefined();
    // And if such a value ever reached the encoder anyway, the shape check
    // that guards it must say no.
    expect(isBytes32ForChainType(addressToBytes32(EVM_SOLVER), "solana")).toBe(false);
  });
});

import { toEventSelector, type AbiEvent } from "viem";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";

/**
 * The output-settler events `/polymer` will mint a proof for.
 *
 * This is an allowlist, not a convenience: the endpoint spends the org's Polymer API key on
 * behalf of an unauthenticated caller, so it must not become a general-purpose proof oracle for
 * arbitrary logs. Adding an event here widens what anyone can get proved.
 *
 * - `OutputFilled`    — a solver delivered the output, so the input settler can finalise.
 * - `OutputNotFilled` — the fill deadline passed with nothing delivered, so the input settler
 *                       can refund the user early via `refundOnNonFill` rather than waiting out
 *                       `expires`.
 */
export const PROVABLE_EVENT_NAMES = ["OutputFilled", "OutputNotFilled"] as const;

export type ProvableEventName = (typeof PROVABLE_EVENT_NAMES)[number];

/**
 * Expected topic0 per event, pinned.
 *
 * The gate is nothing but a topic0 comparison, so a signature drift — a reordered
 * `MandateOutput` field, a changed parameter type — would not fail loudly. It would quietly
 * stop matching real logs and 400 every proof request. Pinning turns that into a boot error.
 *
 * Both values are confirmed against the deployed `OutputSettlerSimple`
 * (0x75220B7600c300005038432a0000f308e0000068), where each appears as a PUSH32 constant in the
 * runtime bytecode on Base, Arbitrum One and OP Mainnet.
 */
export const EXPECTED_TOPIC0: Record<ProvableEventName, `0x${string}`> = {
	OutputFilled: "0xfef24569acf839f2b5cb23fd59d8a9bcc21650ff711ac1961ca3c5d4681ffe12",
	OutputNotFilled: "0xf73516bd5d6277333b9b4d2830f5dab6de8d2f496097f7738b6e2e233119a2c7"
};

/** Resolve one allowlisted event from the ABI, failing loudly rather than silently. */
function provableEvent(name: ProvableEventName): AbiEvent {
	const event = COIN_FILLER_ABI.find((item) => item.type === "event" && item.name === name);
	// A cast alone would hide a missing entry: `.find` returns undefined, viem receives an
	// undefined event, and the filter silently stops matching anything. Throw at import instead.
	if (!event) throw new Error(`COIN_FILLER_ABI is missing the ${name} event`);
	const topic0 = toEventSelector(event as AbiEvent);
	if (topic0 !== EXPECTED_TOPIC0[name]) {
		throw new Error(
			`${name} topic0 changed: ABI yields ${topic0}, expected ${EXPECTED_TOPIC0[name]}`
		);
	}
	return event as AbiEvent;
}

export const PROVABLE_EVENTS: AbiEvent[] = PROVABLE_EVENT_NAMES.map(provableEvent);

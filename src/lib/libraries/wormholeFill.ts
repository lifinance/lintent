import { encodeFillDescription } from "@lifi/intent";
import type { MandateOutput, OrderContainer } from "@lifi/intent";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex, PublicClient } from "viem";
import { getChain, getClient } from "$lib/config";
import type { WC } from "$lib/config";
import { WORMHOLE_ORACLE_ABI } from "$lib/abi/wormholeoracle";
import { isSolanaChain } from "$lib/utils/chainType";
import { switchWalletChain } from "$lib/utils/walletClientRuntime";
import type { TxRef } from "$lib/utils/txRef";
import { extractRevertReason } from "$lib/utils/revert";
import { getSolanaReads } from "$lib/solana/client";
import { readIsProvenOnSolana } from "$lib/solana/reads";
import type { SolanaDeps } from "$lib/solana/types";
import { publishSolanaWormhole, receiveWormholeVaa } from "$lib/solana/wormhole";
import { getFillDetails } from "./fillEvent";
import { assertWormholeOrderReady } from "./oracleRoute";
import {
  assertWormholeVaa,
  findWormholePublication,
  pollWormholeVaa,
  publishEvmWormhole,
  saveWormholeHint
} from "./wormholeProof";
import type { WormholeExpectedMessage, WormholePublication } from "./wormholeProof";

export type WormholeFillResult =
  | { status: "pending"; publication: WormholePublication }
  | { status: "complete"; transactionHash?: TxRef; attestation?: string };

export type WormholeFillOptions = {
  walletClient: WC;
  inputAccount: () => Hex;
  outputAccount: () => Promise<Hex>;
  solanaDeps: (chainId: bigint) => Promise<SolanaDeps>;
  preHook?: (chainId: number) => Promise<unknown>;
  postHook?: () => Promise<unknown>;
  onProgress?: (stage: string) => void;
};

// Publication consumes one destination-local fill record, regardless of how
// many input chains need its proof. Never key this lock by the input chain.
const publicationInflight = new Map<string, Promise<WormholePublication>>();
const publications = new Map<string, WormholePublication>();
// A VAA can attest multiple outputs. Receiving it once registers them all.
const deliveryInflight = new Map<
  string,
  Promise<{ transactionHash?: TxRef; attestation?: string }>
>();

async function assertInputWallet(wallet: WC, chainId: bigint, account: Hex): Promise<void> {
  if ((await wallet.getChainId()) !== Number(chainId)) {
    throw new Error(
      `Switch your wallet to input chain ${chainId} before registering Wormhole proof.`
    );
  }
  if (
    !/^0x[0-9a-f]{40}$/i.test(account) ||
    !(await wallet.getAddresses()).some(
      (address) => address.toLowerCase() === account.toLowerCase()
    )
  ) {
    throw new Error("Wormhole proof account is not connected to the input wallet.");
  }
}

/** Destination publication and origin registration, independent of the UI verifier toggle. */
export async function validateWormholeFill(
  args: {
    orderContainer: OrderContainer;
    orderId: Hex;
    output: MandateOutput;
    fillTransactionHash: TxRef;
    sourceChainId: bigint;
  },
  opts: WormholeFillOptions
): Promise<WormholeFillResult> {
  const { orderContainer, orderId, output, fillTransactionHash, sourceChainId } = args;
  const inputOracle = orderContainer.order.inputOracle;
  await assertWormholeOrderReady(orderContainer);
  const { solver, timestamp } = await getFillDetails(orderId, output, fillTransactionHash);
  const payload = encodeFillDescription({ solver, timestamp, orderId, output });
  const payloadHash = keccak256(payload);
  const expected: WormholeExpectedMessage = { application: output.settler, payload };
  const readProof = async (): Promise<boolean> => {
    if (isSolanaChain(sourceChainId)) {
      return readIsProvenOnSolana(await getSolanaReads(sourceChainId), {
        inputOracle,
        output,
        payloadHash
      });
    }
    return getClient(sourceChainId).readContract({
      address: inputOracle,
      abi: WORMHOLE_ORACLE_ABI,
      functionName: "isProven",
      args: [output.chainId, output.oracle, output.settler, payloadHash]
    });
  };
  const complete = async (
    result: { transactionHash?: TxRef; attestation?: string } = {}
  ): Promise<WormholeFillResult> => {
    // Intermediates, receipt success, and local hints are not origin proof.
    if (!(await readProof()))
      throw new Error(
        "Wormhole proof is not registered on the input chain. Retry to resume delivery."
      );
    await opts.postHook?.();
    return { status: "complete", ...result };
  };

  // This read is before any wallet preparation, publication, or Scan request:
  // third-party delivery must finish without a fee or wallet prompt.
  if (await readProof()) return complete();

  const publicationKey = `${output.chainId}:${output.oracle.toLowerCase()}:${output.settler.toLowerCase()}:${payloadHash}`;
  let publicationPromise = publicationInflight.get(publicationKey);
  if (!publicationPromise) {
    publicationPromise = (async () => {
      const found = await findWormholePublication(
        output,
        expected,
        publications.get(publicationKey)
      );
      let publication = found;
      if (!publication) {
        opts.onProgress?.("Publish fill");
        await opts.preHook?.(Number(output.chainId));
        if (isSolanaChain(output.chainId)) {
          publication = await publishSolanaWormhole(await opts.solanaDeps(output.chainId), {
            kind: "fill",
            orderId,
            output,
            payload,
            solverBytes32: solver,
            timestamp,
            beforeSpend: () => assertWormholeOrderReady(orderContainer)
          });
        } else {
          publication = await publishEvmWormhole(
            output,
            payload,
            opts.walletClient,
            await opts.outputAccount(),
            {
              beforeSpend: () => assertWormholeOrderReady(orderContainer)
            }
          );
        }
      }
      publications.set(publicationKey, publication);
      saveWormholeHint(output, expected, publication);
      return publication;
    })();
    publicationInflight.set(publicationKey, publicationPromise);
    // Remove only the pending operation, never the recovered publication.
    void publicationPromise
      .finally(() => publicationInflight.delete(publicationKey))
      .catch(() => undefined);
  }
  const publication = await publicationPromise;
  if (await readProof()) return complete();
  opts.onProgress?.("Waiting for Wormhole guardians");
  const result = await pollWormholeVaa(publication, expected, {
    onProgress: () => opts.onProgress?.("Waiting for Wormhole guardians")
  });
  if (await readProof()) return complete();
  if (result.status === "pending") return { status: "pending", publication };
  // Keep the exact binding at the delivery boundary, before preHook can prompt.
  const vaa = assertWormholeVaa(hexToBytes(result.proof), publication, expected);

  const deliveryKey = `${sourceChainId}:${inputOracle.toLowerCase()}:${bytesToHex(vaa.hash)}`;
  let deliveryPromise = deliveryInflight.get(deliveryKey);
  if (!deliveryPromise) {
    deliveryPromise = (async () => {
      if (await readProof()) return {};
      await opts.preHook?.(Number(sourceChainId));
      if (isSolanaChain(sourceChainId)) {
        const received = await receiveWormholeVaa(await opts.solanaDeps(sourceChainId), {
          proof: result.proof,
          output,
          payloadHash,
          beforeSpend: () => assertWormholeOrderReady(orderContainer),
          onProgress: opts.onProgress
        });
        return { transactionHash: received.attestSignature, attestation: received.attestation };
      }

      const wallet = opts.walletClient;
      if ((await wallet.getChainId()) !== Number(sourceChainId)) {
        await switchWalletChain(wallet, Number(sourceChainId));
      }
      const account = opts.inputAccount();
      await assertInputWallet(wallet, sourceChainId, account);
      const client = getClient(sourceChainId) as PublicClient;
      if (BigInt(await client.getChainId()) !== sourceChainId) {
        throw new Error(
          "Wormhole proof RPC serves a different input chain. Retry with the correct RPC."
        );
      }
      if (await readProof()) return {};
      opts.onProgress?.("Register proof");
      let request;
      try {
        ({ request } = await client.simulateContract({
          account,
          address: inputOracle,
          abi: WORMHOLE_ORACLE_ABI,
          functionName: "receiveMessage",
          args: [result.proof]
        }));
      } catch (cause) {
        throw new Error(
          `receiveMessage simulation failed on chain ${sourceChainId}: ${extractRevertReason(cause)}`,
          { cause }
        );
      }
      await assertInputWallet(wallet, sourceChainId, account);
      await assertWormholeOrderReady(orderContainer);
      if (await readProof()) return {};
      const transactionHash = await wallet.writeContract({
        ...request,
        account,
        abi: WORMHOLE_ORACLE_ABI,
        functionName: "receiveMessage",
        args: [result.proof],
        chain: getChain(sourceChainId)
      });
      const receipt = await client.waitForTransactionReceipt({
        hash: transactionHash,
        timeout: 120_000,
        pollingInterval: 2_000
      });
      if (receipt.status !== "success")
        throw new Error("Wormhole proof registration transaction reverted.");
      return { transactionHash };
    })();
    deliveryInflight.set(deliveryKey, deliveryPromise);
    void deliveryPromise.finally(() => deliveryInflight.delete(deliveryKey)).catch(() => undefined);
  }
  return complete(await deliveryPromise);
}

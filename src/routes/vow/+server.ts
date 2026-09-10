import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";
import { proxyVowWitness } from "$lib/server/vowWitness";

export const POST: RequestHandler = ({ request, fetch }) =>
  proxyVowWitness(request, fetch, {
    endpoint: env.PRIVATE_VOW_WITNESS_ENDPOINT,
    apiKey: env.PRIVATE_VOW_WITNESS_API_KEY,
    signerIndex: env.PRIVATE_VOW_WITNESS_SIGNER_INDEX
  });

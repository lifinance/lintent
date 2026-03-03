import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import {
	PRIVATE_POLYMER_MAINNET_ZONE_API_KEY,
	PRIVATE_POLYMER_TESTNET_ZONE_API_KEY
} from "$env/static/private";
import { toByteArray } from "base64-js";

function getPolymerUrl(mainnet: boolean) {
	return mainnet
		? ("https://api.polymer.zone/v1/" as const)
		: ("https://api.testnet.polymer.zone/v1/" as const);
}

function getPolymerKey(mainnet: boolean) {
	return mainnet ? PRIVATE_POLYMER_MAINNET_ZONE_API_KEY : PRIVATE_POLYMER_TESTNET_ZONE_API_KEY;
}

export const POST: RequestHandler = async ({ request }) => {
	const { srcChainId, srcBlockNumber, globalLogIndex, polymerIndex, mainnet } =
		await request.json();
	console.log({ srcChainId, srcBlockNumber, globalLogIndex, polymerIndex, mainnet });

	const POLYMER_URL = getPolymerUrl(mainnet ?? true);
	const PRIVATE_POLYMER_ZONE_API_KEY = getPolymerKey(mainnet ?? true);

	let polymerRequestIndex = polymerIndex;
	if (!polymerRequestIndex) {
		const requestProof = await axios.post(
			POLYMER_URL,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "polymer_requestProof",
				params: [
					{
						srcChainId,
						srcBlockNumber,
						globalLogIndex
					}
				]
			},
			{
				headers: {
					Authorization: `Bearer ${PRIVATE_POLYMER_ZONE_API_KEY}`,
					"Content-Type": "application/json",
					Accept: "application/json"
				}
			}
		);
		polymerRequestIndex = requestProof.data.result;
		console.log({ requestProof: requestProof.data });
	}
	const requestProofData = await axios.post(
		POLYMER_URL,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "polymer_queryProof",
			params: [polymerRequestIndex]
		},
		{
			headers: {
				Authorization: `Bearer ${PRIVATE_POLYMER_ZONE_API_KEY}`,
				"Content-Type": "application/json",
				Accept: "application/json"
			}
		}
	);
	const dat: {
		jsonrpc: "2.0";
		id: 1;
		result: {
			jobID: number;
			createdAt: number;
			updatedAt: number;
		} & (
			| {
					status: "error";
					failureReason: string;
			  }
			| {
					status: "complete";
					proof: "string";
			  }
			| {
					status: "initialized";
			  }
		);
	} = requestProofData.data;

	let proof: string | undefined;
	// decode proof from base64 to hex
	if (dat.result.status === "complete") {
		proof = dat.result.proof;
		const proofBytes = toByteArray(proof);
		proof = Array.from(proofBytes)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	} else {
		console.log(dat);
	}
	// create a JSON Response
	return json({
		proof,
		polymerIndex: polymerRequestIndex,
		status: dat.result.status
	});
};

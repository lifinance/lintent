import { NextResponse } from "next/server";

function getPolymerUrl(mainnet: boolean) {
  return mainnet
    ? "https://api.polymer.zone/v1/"
    : "https://api.testnet.polymer.zone/v1/";
}

function getPolymerKey(mainnet: boolean) {
  return mainnet
    ? process.env.PRIVATE_POLYMER_MAINNET_ZONE_API_KEY
    : process.env.PRIVATE_POLYMER_TESTNET_ZONE_API_KEY;
}

export async function POST(req: Request): Promise<Response> {
  const {
    srcChainId,
    srcBlockNumber,
    globalLogIndex,
    txSignature,
    programID,
    polymerIndex,
    mainnet,
  } = (await req.json()) as {
    srcChainId: number;
    srcBlockNumber?: number;
    globalLogIndex?: number;
    txSignature?: string;
    programID?: string;
    polymerIndex?: number;
    mainnet?: boolean;
  };

  const POLYMER_URL = getPolymerUrl(mainnet ?? true);
  const apiKey = getPolymerKey(mainnet ?? true);

  if (!apiKey) {
    return NextResponse.json(
      { error: "Polymer API key not configured. Set PRIVATE_POLYMER_TESTNET_ZONE_API_KEY or PRIVATE_POLYMER_MAINNET_ZONE_API_KEY in .env.local" },
      { status: 500 },
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  let polymerRequestIndex = polymerIndex;
  if (!polymerRequestIndex) {
    const proofParams =
      txSignature && programID
        ? { srcChainId, txSignature, programID }
        : { srcChainId, srcBlockNumber, globalLogIndex };

    const requestProofRes = await fetch(POLYMER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "polymer_requestProof",
        params: [proofParams],
      }),
    });
    if (!requestProofRes.ok) {
      const text = await requestProofRes.text();
      return NextResponse.json(
        { error: `Polymer requestProof failed (${requestProofRes.status}): ${text}` },
        { status: 502 },
      );
    }
    const requestProofData = (await requestProofRes.json()) as { result: number; error?: { message: string } };
    if (requestProofData.error) {
      return NextResponse.json(
        { error: `Polymer requestProof error: ${requestProofData.error.message}` },
        { status: 502 },
      );
    }
    polymerRequestIndex = requestProofData.result;
  }

  const queryRes = await fetch(POLYMER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "polymer_queryProof",
      params: [polymerRequestIndex],
    }),
  });
  const dat = (await queryRes.json()) as {
    jsonrpc: "2.0";
    id: 1;
    result:
      | { status: "error"; failureReason: string; jobID: number; createdAt: number; updatedAt: number }
      | { status: "complete"; proof: string; jobID: number; createdAt: number; updatedAt: number }
      | { status: "initialized"; jobID: number; createdAt: number; updatedAt: number };
  };

  let proof: string | undefined;
  if (dat.result.status === "complete") {
    const proofBase64 = dat.result.proof;
    const proofBytes = Buffer.from(proofBase64, "base64");
    proof = Array.from(proofBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  return NextResponse.json({
    proof,
    polymerIndex: polymerRequestIndex,
    status: dat.result.status,
  });
}

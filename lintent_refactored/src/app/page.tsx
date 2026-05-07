"use client";
import { type ReactElement } from "react";

import { useRouter } from "next/navigation";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ListIcon from "@mui/icons-material/List";
import { AppCard } from "../components/shared/ui/AppCard.tsx";
import { AppButton } from "../components/shared/ui/AppButton.tsx";
import { ChainTokenRow } from "../components/shared/ChainTokenRow.tsx";
import { useChainSelection } from "../hooks/shared/useChainSelection.ts";
import { getEvmChains, getEvmTokensForChain } from "../lib/config/evm.ts";
import {
  getSvmTokens,
  getSvmViemChainId,
  isSolanaViemChainId,
} from "../lib/config/svm.ts";
import type { Vm } from "../types/shared.ts";
import type { SelectedChainToken } from "../store/selection.ts";

function makeDefaultEvmChain(chainId: number, mainnet: boolean): SelectedChainToken | null {
  const tokens = getEvmTokensForChain(chainId, mainnet);
  const token = tokens[0];
  if (!token) return null;
  return {
    chainId,
    tokenAddress: token.address,
    tokenName: token.name,
    tokenDecimals: token.decimals,
    amount: 0n,
  };
}

function makeDefaultSvmChain(mainnet: boolean): SelectedChainToken {
  const tokens = getSvmTokens(mainnet);
  const token = tokens[0] ?? { bytes32Address: "0x", name: "SOL", decimals: 9 };
  return {
    chainId: getSvmViemChainId(mainnet),
    tokenAddress: "bytes32Address" in token ? token.bytes32Address : "0x",
    tokenName: token.name,
    tokenDecimals: token.decimals,
    amount: 0n,
  };
}

export default function HomePage(): ReactElement {
  const router = useRouter();
  const {
    mainnet,
    inputVm,
    inputChains,
    outputChains,
    setMainnet,
    setInputVm,
    setInputChains,
    addInputChain,
    removeInputChain,
    updateInputChain,
    addOutputChain,
    removeOutputChain,
    updateOutputChain,
  } = useChainSelection();

  const evmChains = getEvmChains(mainnet);

  const canAddMoreInputs = inputVm === "evm" && inputChains.length < evmChains.length;
  const hasValidInputs = inputChains.length > 0 && inputChains.every((c) => c.amount > 0n);
  const hasValidOutputs = outputChains.length > 0 && outputChains.every((c) => c.amount > 0n);
  const canContinue = hasValidInputs && hasValidOutputs;

  const handleVmSelect = (vm: Vm): void => {
    setInputVm(vm);
    if (vm === "svm") {
      setInputChains([makeDefaultSvmChain(mainnet)]);
    } else {
      const firstChain = evmChains[0];
      if (!firstChain) return;
      const defaultChain = makeDefaultEvmChain(firstChain.id, mainnet);
      if (defaultChain) setInputChains([defaultChain]);
    }
  };

  const handleAddEvmInput = (): void => {
    const usedIds = new Set(inputChains.map((c) => c.chainId));
    const nextChain = evmChains.find((c) => !usedIds.has(c.id));
    if (!nextChain) return;
    const defaultChain = makeDefaultEvmChain(nextChain.id, mainnet);
    if (defaultChain) addInputChain(defaultChain);
  };

  const handleAddEvmOutput = (): void => {
    const usedIds = new Set(outputChains.map((c) => c.chainId));
    const nextChain = evmChains.find((c) => !usedIds.has(c.id));
    if (!nextChain) return;
    const defaultChain = makeDefaultEvmChain(nextChain.id, mainnet);
    if (defaultChain) addOutputChain(defaultChain);
  };

  const hasSolanaOutput = outputChains.some((c) => isSolanaViemChainId(c.chainId));

  const handleAddSolanaOutput = (): void => {
    if (hasSolanaOutput) return;
    addOutputChain(makeDefaultSvmChain(mainnet));
  };

  const handleContinue = (): void => {
    if (inputVm === "evm") router.push("/evm");
    else if (inputVm === "svm") router.push("/svm");
  };

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={4}>

        {/* Header */}
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Stack spacing={0.5}>
            <Typography variant="h4" fontWeight={700}>
              New Intent
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Lock input tokens and specify desired outputs across chains.
            </Typography>
          </Stack>
          <Button
            component="a"
            href="/intents"
            startIcon={<ListIcon />}
            size="small"
            variant="outlined"
          >
            My Intents
          </Button>
        </Stack>

        {/* Network toggle */}
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" color="text.secondary">Network:</Typography>
          <ToggleButtonGroup
            value={mainnet ? "mainnet" : "testnet"}
            exclusive
            onChange={(_, v: string | null) => { if (v) setMainnet(v === "mainnet"); }}
            size="small"
          >
            <ToggleButton value="testnet">Testnet</ToggleButton>
            <ToggleButton value="mainnet">Mainnet</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {/* Input VM selector */}
        <AppCard>
          <Stack spacing={2}>
            <Typography variant="subtitle1" fontWeight={600}>
              Input Chain Type
            </Typography>
            <Typography variant="body2" color="text.secondary">
              EVM allows multiple input chains. Solana is a single input chain.
            </Typography>
            <ToggleButtonGroup
              value={inputVm}
              exclusive
              onChange={(_, v: Vm | null) => { if (v) handleVmSelect(v); }}
              fullWidth
            >
              <ToggleButton value="evm">EVM (multi-chain)</ToggleButton>
              <ToggleButton value="svm">Solana (single)</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </AppCard>

        {/* Input chains */}
        {inputVm !== null && inputChains.length > 0 && (
          <AppCard>
            <Stack spacing={2}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle1" fontWeight={600}>Inputs</Typography>
                {canAddMoreInputs && (
                  <Button size="small" startIcon={<AddIcon />} onClick={handleAddEvmInput}>
                    Add chain
                  </Button>
                )}
              </Stack>
              {inputChains.map((chain, index) => (
                <Stack key={chain.chainId} direction="row" spacing={1} alignItems="flex-end">
                  <Box sx={{ flexGrow: 1 }}>
                    <ChainTokenRow
                      vm={inputVm}
                      chainId={chain.chainId}
                      tokenAddress={chain.tokenAddress}
                      amount={chain.amount}
                      tokenDecimals={chain.tokenDecimals}
                      mainnet={mainnet}
                      showChainSelector={inputVm === "evm"}
                      disabledChainIds={inputChains
                        .filter((_, i) => i !== index)
                        .map((c) => c.chainId)}
                      onChainChange={(newChainId) => {
                        const tokens = getEvmTokensForChain(newChainId, mainnet);
                        const t = tokens[0];
                        if (!t) return;
                        updateInputChain(chain.chainId, {
                          chainId: newChainId,
                          tokenAddress: t.address,
                          tokenName: t.name,
                          tokenDecimals: t.decimals,
                        });
                      }}
                      onTokenChange={(tokenAddress, tokenName, tokenDecimals) => {
                        updateInputChain(chain.chainId, { tokenAddress, tokenName, tokenDecimals });
                      }}
                      onAmountChange={(amount) => {
                        updateInputChain(chain.chainId, { amount });
                      }}
                    />
                  </Box>
                  {inputVm === "evm" && inputChains.length > 1 && (
                    <IconButton
                      size="small"
                      onClick={() => removeInputChain(chain.chainId)}
                      sx={{ mb: 0.5 }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
              ))}
            </Stack>
          </AppCard>
        )}

        {/* Output chains */}
        <AppCard>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="subtitle1" fontWeight={600}>Outputs</Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" startIcon={<AddIcon />} onClick={handleAddEvmOutput}>
                  EVM
                </Button>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={handleAddSolanaOutput}
                  disabled={hasSolanaOutput}
                >
                  Solana
                </Button>
              </Stack>
            </Stack>
            {outputChains.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                Add at least one output chain and token.
              </Typography>
            )}
            {outputChains.map((chain, index) => {
              const isSolana = isSolanaViemChainId(chain.chainId);
              return (
                <Stack key={chain.chainId} direction="row" spacing={1} alignItems="flex-end">
                  <Box sx={{ flexGrow: 1 }}>
                    <ChainTokenRow
                      vm={isSolana ? "svm" : "evm"}
                      chainId={chain.chainId}
                      tokenAddress={chain.tokenAddress}
                      amount={chain.amount}
                      tokenDecimals={chain.tokenDecimals}
                      mainnet={mainnet}
                      showChainSelector
                      disabledChainIds={outputChains
                        .filter((_, i) => i !== index)
                        .map((c) => c.chainId)}
                      onChainChange={(newChainId) => {
                        if (isSolanaViemChainId(newChainId)) return;
                        const tokens = getEvmTokensForChain(newChainId, mainnet);
                        const t = tokens[0];
                        if (!t) return;
                        updateOutputChain(chain.chainId, {
                          chainId: newChainId,
                          tokenAddress: t.address,
                          tokenName: t.name,
                          tokenDecimals: t.decimals,
                        });
                      }}
                      onTokenChange={(tokenAddress, tokenName, tokenDecimals) => {
                        updateOutputChain(chain.chainId, { tokenAddress, tokenName, tokenDecimals });
                      }}
                      onAmountChange={(amount) => {
                        updateOutputChain(chain.chainId, { amount });
                      }}
                    />
                  </Box>
                  <IconButton
                    size="small"
                    onClick={() => removeOutputChain(chain.chainId)}
                    sx={{ mb: 0.5 }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              );
            })}
          </Stack>
        </AppCard>

        <Divider />

        <AppButton
          variant="contained"
          size="large"
          disabled={!canContinue}
          onClick={handleContinue}
          fullWidth
        >
          Continue →
        </AppButton>
      </Stack>
    </Container>
  );
}

"use client";
import { type ComponentType, type ReactElement } from "react";
import Stack from "@mui/material/Stack";
import { EvmWalletButton } from "../evm/EvmWalletButton";
import { SvmWalletButton } from "../svm/SvmWalletButton";
import { WALLET_KIND_IDS, type WalletKindId } from "../../lib/wallet/kinds";

/**
 * Component map: which connect-button renders for each wallet kind. Adding a
 * new kind only requires registering it here (and in `kinds.ts`); the bar
 * picks it up automatically.
 */
const WALLET_BUTTONS: Readonly<Record<WalletKindId, ComponentType>> = {
  evm: EvmWalletButton,
  svm: SvmWalletButton,
};

type WalletConnectBarProps = {
  /**
   * Restrict the bar to a specific subset of kinds. Defaults to all
   * registered kinds (the typical case — every page wants every wallet).
   */
  readonly kinds?: readonly WalletKindId[];
};

export function WalletConnectBar({ kinds }: WalletConnectBarProps = {}): ReactElement {
  const ids = kinds ?? WALLET_KIND_IDS;
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
    >
      {ids.map((id) => {
        const Btn = WALLET_BUTTONS[id];
        return <Btn key={id} />;
      })}
    </Stack>
  );
}

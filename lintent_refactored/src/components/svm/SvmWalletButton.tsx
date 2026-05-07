"use client";
import { type ReactElement } from "react";

import { useState, useEffect } from "react";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { SolanaIcon } from "./SolanaIcon";
import { useSvmWallet } from "../../hooks/svm/useSvmWallet.ts";

export function SvmWalletButton(): ReactElement {
  const { publicKey, isConnected, wallets, connect, disconnect } = useSvmWallet();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const menuOpen = Boolean(anchorEl);

  const shortKey = publicKey
    ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`
    : null;

  const handleDisconnect = (): void => {
    void disconnect();
    setAnchorEl(null);
  };

  const handleConnect = (walletName: string): void => {
    void connect(walletName);
    setAnchorEl(null);
  };

  if (mounted && isConnected && publicKey) {
    return (
      <>
        <Button
          variant="outlined"
          color="secondary"
          startIcon={<SolanaIcon />}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          size="small"
        >
          {shortKey}
        </Button>
        <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">
              {publicKey}
            </Typography>
          </MenuItem>
          <MenuItem onClick={handleDisconnect}>Disconnect</MenuItem>
        </Menu>
      </>
    );
  }

  return (
    <>
      <Button
        variant="contained"
        color="secondary"
        startIcon={<SolanaIcon />}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        size="small"
      >
        Connect Solana Wallet
      </Button>
      <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
        {wallets.map((w) => (
          <MenuItem key={w.adapter.name} onClick={() => handleConnect(w.adapter.name)}>
            {w.adapter.name}
          </MenuItem>
        ))}
        {wallets.length === 0 && (
          <MenuItem disabled>No wallets detected</MenuItem>
        )}
      </Menu>
    </>
  );
}

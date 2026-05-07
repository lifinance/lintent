"use client";
import { type ReactElement } from "react";

import { useState, useEffect } from "react";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import { useEvmWallet } from "../../hooks/evm/useEvmWallet";

export function EvmWalletButton(): ReactElement {
  const { address, isConnected, connectors, connect, disconnect } = useEvmWallet();
  const evmConnectors = connectors.filter(
    (c) => !c.name.toLowerCase().includes("phantom"),
  );
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const menuOpen = Boolean(anchorEl);

  const shortAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : null;

  if (mounted && isConnected && address) {
    return (
      <>
        <Button
          variant="outlined"
          startIcon={<AccountBalanceWalletIcon />}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          size="small"
        >
          {shortAddress}
        </Button>
        <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">{address}</Typography>
          </MenuItem>
          <MenuItem
            onClick={() => { disconnect(); setAnchorEl(null); }}
          >
            Disconnect
          </MenuItem>
        </Menu>
      </>
    );
  }

  return (
    <>
      <Button
        variant="contained"
        startIcon={<AccountBalanceWalletIcon />}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        size="small"
      >
        Connect EVM Wallet
      </Button>
      <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
        {evmConnectors.map((c) => (
          <MenuItem key={c.uid} onClick={() => { connect(c); setAnchorEl(null); }}>
            {c.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

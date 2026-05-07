"use client";
import { type ReactElement } from "react";

import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import type { SettlerType } from "../../types/shared";

type SettlerSelectorProps = {
  value: SettlerType;
  onChange: (settler: SettlerType) => void;
};

export function SettlerSelector({ value, onChange }: SettlerSelectorProps): ReactElement {
  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary" fontWeight={600} letterSpacing={1}>
        SETTLER TYPE
      </Typography>
      <ToggleButtonGroup
        value={value}
        exclusive
        onChange={(_, v: SettlerType | null) => { if (v) onChange(v); }}
        size="small"
      >
        <Tooltip title="Lock tokens in escrow contract directly">
          <ToggleButton value="escrow">Escrow</ToggleButton>
        </Tooltip>
        <Tooltip title="Use The Compact protocol for capital efficiency">
          <ToggleButton value="compact">Compact</ToggleButton>
        </Tooltip>
      </ToggleButtonGroup>
    </Stack>
  );
}

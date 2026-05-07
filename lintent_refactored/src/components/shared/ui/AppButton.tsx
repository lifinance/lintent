"use client";
import { type ReactElement } from "react";

import Button, { type ButtonProps } from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";

type AppButtonProps = ButtonProps & {
  loading?: boolean;
};

export function AppButton({ loading = false, disabled, children, ...rest }: AppButtonProps): ReactElement {
  return (
    <Button
      disabled={disabled || loading}
      startIcon={loading ? <CircularProgress size={16} color="inherit" /> : rest.startIcon}
      {...rest}
    >
      {children}
    </Button>
  );
}

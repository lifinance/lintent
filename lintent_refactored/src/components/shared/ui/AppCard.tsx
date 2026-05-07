import { type ReactElement } from "react";
import Paper, { type PaperProps } from "@mui/material/Paper";
import Box from "@mui/material/Box";

type AppCardProps = PaperProps & {
  children: React.ReactNode;
};

export function AppCard({ children, sx, ...rest }: AppCardProps): ReactElement {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 3,
        borderRadius: 2,
        borderColor: "divider",
        background: "rgba(255,255,255,0.03)",
        ...sx,
      }}
      {...rest}
    >
      <Box>{children}</Box>
    </Paper>
  );
}

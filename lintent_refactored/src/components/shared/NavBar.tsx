"use client";
import { type ReactElement } from "react";

import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Link from "next/link";
import HomeIcon from "@mui/icons-material/Home";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

export function NavBar(): ReactElement {
  return (
    <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Toolbar variant="dense" sx={{ minHeight: 48 }}>
        <Typography
          variant="h6"
          fontWeight={700}
          component={Link}
          href="/"
          sx={{ textDecoration: "none", color: "primary.main", mr: 3 }}
        >
          Lintent
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button component={Link} href="/" size="small" startIcon={<HomeIcon />} color="inherit">
            Home
          </Button>
          <Button component={Link} href="/about" size="small" startIcon={<InfoOutlinedIcon />} color="inherit">
            About
          </Button>
        </Stack>
        <Box sx={{ flexGrow: 1 }} />
      </Toolbar>
    </AppBar>
  );
}

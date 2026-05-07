import { type ReactElement } from "react";

import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import Divider from "@mui/material/Divider";

export default function AboutPage(): ReactElement {
  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Typography variant="h4" fontWeight={700}>
          About Lintent
        </Typography>

        <Typography variant="body1">
          This webapp demonstrates chain abstraction using the{" "}
          <Link href="https://github.com/openintentsframework/oif-contracts" target="_blank" rel="noopener">
            Open Intents Framework
          </Link>
          . It supports a seamless resource lock flow using{" "}
          <Link href="https://github.com/Uniswap/the-compact/tree/v1" target="_blank" rel="noopener">
            The Compact
          </Link>
          {" "}and a traditional escrow flow, along with cross-chain intents between EVM chains and Solana.
        </Typography>

        <Divider />

        <Typography variant="h6" fontWeight={600}>Multichain</Typography>
        <Typography variant="body2">
          A multichain intent is an intent that collects inputs on multiple chains, providing the result
          on one or more chains. In other words, a multichain intent is an <em>any to any</em> intent.
          Multichain intents are currently work in progress and may change in the future. If you are using
          this interface for testing, ensure the <strong>multichain</strong> flag is not shown.
        </Typography>

        <Divider />

        <Typography variant="h6" fontWeight={600}>Why Resource Locks?</Typography>
        <Typography variant="body2">
          Resource Locks improve asset availability guarantees in cross-chain contexts and asynchronous
          environments, offering several key advantages:
        </Typography>
        <Typography component="ul" variant="body2" sx={{ pl: 3 }}>
          <li>Funds are only debited after successful delivery has been proven.</li>
          <li>Enables efficient short-lived interactions — intents can expire within seconds without consequence.</li>
          <li>No upfront deposit or initiation transaction are required.</li>
          <li>Fully composable with other protocols and settlement layers.</li>
        </Typography>
        <Typography variant="body2">
          Learn more about{" "}
          <Link href="https://docs.li.fi/lifi-intents/knowledge-database/resource-locks" target="_blank" rel="noopener">
            Resource Locks
          </Link>.
        </Typography>

        <Divider />

        <Typography variant="h6" fontWeight={600}>Why the Open Intents Framework?</Typography>
        <Typography variant="body2">
          The Open Intents Framework (OIF) is an open coordination layer for standardizing and scaling
          intent-based workflows across chains. The goal is to:
        </Typography>
        <Typography component="ul" variant="body2" sx={{ pl: 3 }}>
          <li>Standardise cross-chain interactions.</li>
          <li>Define a permissionless intent implementation that can scale across all chains.</li>
          <li>Create a reference implementation for cross-chain solvers and searchers.</li>
          <li>Provide tooling for wallet and app developers.</li>
        </Typography>
        <Typography variant="body2">
          Learn more about{" "}
          <Link href="https://openintents.xyz" target="_blank" rel="noopener">
            Open Intents Framework
          </Link>.
        </Typography>

        <Divider />

        <Typography variant="h6" fontWeight={600}>Same Chain</Typography>
        <Typography variant="body2">
          A same chain intent is an intent that only has inputs and outputs on the same chain. The oracle
          is configured differently to a cross-chain intent. SetAttestation has to be called on the output
          settler to expose the filled output. Learn more about same chain intents or{" "}
          <Link
            href="https://github.com/catalystsystem/catalyst-intent/blob/997649a2e2474d4c3e59afc631c6afd45a9040dc/test/integration/InputSettler7683LIFI.samechain.t.sol#L169-L174"
            target="_blank"
            rel="noopener"
          >
            explore a demo
          </Link>
          {" "}of how to collect inputs before delivering outputs.
        </Typography>
      </Stack>
    </Container>
  );
}

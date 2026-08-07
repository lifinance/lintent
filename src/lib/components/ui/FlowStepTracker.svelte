<script lang="ts">
  import FlowProgressList, { type FlowStep } from "$lib/components/ui/FlowProgressList.svelte";
  import {
    EMPTY_FLOW_CHECKS,
    getOrderProgressChecks,
    getOutputStorageKey,
    type FlowCheckState
  } from "$lib/libraries/flowProgress";
  import store from "$lib/state.svelte";
  import type { OrderContainer } from "@lifi/intent";

  let {
    currentScreenIndex,
    scrollStepProgress,
    selectedOrder,
    onStepClick,
    className = ""
  }: {
    currentScreenIndex: number;
    scrollStepProgress: number;
    selectedOrder: OrderContainer | undefined;
    onStepClick?: (step: FlowStep) => void;
    className?: string;
  } = $props();

  let progressRefreshTick = $state(0);
  let flowChecksRun = 0;
  let flowChecks = $state<FlowCheckState>({ ...EMPTY_FLOW_CHECKS });

  const selectedOutputFillHashSignature = $derived.by(() => {
    if (!selectedOrder) return "";
    return selectedOrder.order.outputs
      .map((output) => store.fillTransactions[getOutputStorageKey(output)] ?? "")
      .join("|");
  });

  $effect(() => {
    const interval = setInterval(() => {
      progressRefreshTick += 1;
    }, 30_000);
    return () => clearInterval(interval);
  });

  $effect(() => {
    progressRefreshTick;
    store.connectedAccount;
    store.walletClient;
    selectedOrder;
    selectedOutputFillHashSignature;

    if (!store.anyWalletConnected || !selectedOrder) {
      flowChecks = { ...EMPTY_FLOW_CHECKS };
      return;
    }

    const currentRun = ++flowChecksRun;
    // The persisted Hyperlane submit records are passed in explicitly so a dispatch (or a
    // dropped record after a reverted submit) is a dependency of this effect: it decides
    // whether the prove step reads "Submit" or "Relaying".
    getOrderProgressChecks(selectedOrder, store.fillTransactions, {
      ...store.hyperlaneSubmissions
    })
      .then((checks) => {
        if (currentRun !== flowChecksRun) return;
        flowChecks = checks;
      })
      .catch((error) => {
        console.warn("flow progress update failed", error);
        if (currentRun !== flowChecksRun) return;
        flowChecks = { ...EMPTY_FLOW_CHECKS };
      });
  });

  const progressSteps = $derived.by(() => {
    const connected = store.anyWalletConnected;
    if (!connected) {
      return [
        {
          id: "connect",
          label: "Connect Wallet",
          status: "active",
          clickable: true,
          targetIndex: 0
        },
        {
          id: "assets",
          label: "Assets Management",
          status: "locked",
          clickable: false
        },
        {
          id: "issue",
          label: "Intent Issuance",
          status: "locked",
          clickable: false
        },
        {
          id: "select",
          label: "Select Intent",
          status: "locked",
          clickable: false
        },
        {
          id: "fill",
          label: "Fill Intent",
          status: "locked",
          clickable: false
        },
        {
          id: "proof",
          label: "Submit Proof",
          status: "locked",
          clickable: false
        },
        {
          id: "finalise",
          label: "Finalise Intent",
          status: "locked",
          clickable: false
        }
      ] as FlowStep[];
    }

    const selected = selectedOrder !== undefined;
    const activeByIndex = ["assets", "issue", "select", "fill", "proof", "finalise"];
    const activeStep =
      activeByIndex[Math.max(0, Math.min(currentScreenIndex, activeByIndex.length - 1))];

    const assetsDone = currentScreenIndex >= 1;
    const issueDone = currentScreenIndex >= 2;
    const fetchDone = selected || currentScreenIndex >= 3;
    const fillDone = flowChecks.allFilled || currentScreenIndex >= 4;
    const proveDone = flowChecks.allValidated || currentScreenIndex >= 5;
    // Only a claim completes the flow. A refund is terminal but is a failure — never
    // paint it as done, or a solver who was refunded after filling sees a green tick.
    const claimDone = flowChecks.allClaimed;

    const stepStatus = (opts: {
      active: boolean;
      done: boolean;
      unlocked: boolean;
    }): FlowStep["status"] => {
      if (!opts.unlocked) return "locked";
      if (opts.active) return "active";
      return opts.done ? "completed" : "pending";
    };

    return [
      {
        id: "assets",
        label: "Asset",
        status: stepStatus({
          active: activeStep === "assets",
          done: assetsDone,
          unlocked: true
        }),
        clickable: true,
        targetIndex: 0
      },
      {
        id: "issue",
        label: "Issue",
        status: stepStatus({
          active: activeStep === "issue",
          done: issueDone,
          unlocked: true
        }),
        clickable: true,
        targetIndex: 1
      },
      {
        id: "select",
        label: "Fetch",
        status: stepStatus({
          active: activeStep === "select",
          done: fetchDone,
          unlocked: true
        }),
        clickable: true,
        targetIndex: 2
      },
      {
        id: "fill",
        label: "Fill",
        status: stepStatus({
          active: activeStep === "fill",
          done: fillDone,
          unlocked: fetchDone || activeStep === "fill"
        }),
        clickable: fetchDone || activeStep === "fill",
        targetIndex: 3
      },
      {
        id: "proof",
        // Hyperlane is push-based: there is no proof to fetch. But there IS a dispatch
        // the solver has to pay for, so the step has two distinct pre-states — "nothing
        // submitted yet" and "message in flight, waiting on a relayer" — and calling the
        // first one "Relaying" would claim work that never happened.
        label: flowChecks.awaitingRelayer
          ? "Relaying"
          : flowChecks.awaitingSubmit
            ? "Submit"
            : "Prove",
        status: stepStatus({
          active: activeStep === "proof",
          done: proveDone,
          unlocked: fillDone || activeStep === "proof"
        }),
        clickable: fillDone || activeStep === "proof",
        targetIndex: 4
      },
      {
        id: "finalise",
        label: "Claim",
        status: stepStatus({
          active: activeStep === "finalise",
          done: claimDone,
          unlocked: proveDone || activeStep === "finalise"
        }),
        clickable: proveDone || activeStep === "finalise",
        targetIndex: 5
      }
    ] as FlowStep[];
  });

  const progressConnectorPosition = $derived.by(() => {
    if (!store.anyWalletConnected) return 0;
    const maxIndex = Math.max(progressSteps.length - 1, 0);
    return Math.max(0, Math.min(scrollStepProgress, maxIndex));
  });
</script>

<FlowProgressList
  {className}
  steps={progressSteps}
  progress={progressConnectorPosition}
  {onStepClick}
/>

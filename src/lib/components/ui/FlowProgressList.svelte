<script lang="ts">
  export type FlowStep = {
    id: string;
    label: string;
    status: "completed" | "active" | "pending" | "locked";
    clickable: boolean;
    targetIndex?: number;
  };

  let {
    steps,
    onStepClick,
    progress = 0,
    className = ""
  }: {
    steps: FlowStep[];
    onStepClick?: (step: FlowStep) => void;
    progress?: number;
    className?: string;
  } = $props();

  const statusText: Record<FlowStep["status"], string> = {
    completed: "Done",
    active: "Now",
    pending: "Next",
    locked: "Locked"
  };

  const chipClass: Record<FlowStep["status"], string> = {
    completed: "border-emerald-300 bg-emerald-50 text-emerald-800",
    active: "border-sky-300 bg-sky-50 text-sky-800",
    pending: "border-gray-200 bg-white text-gray-700",
    locked: "border-gray-200 bg-gray-100 text-gray-400"
  };

  const connectorClass: Record<FlowStep["status"], string> = {
    completed: "bg-emerald-300",
    active: "bg-sky-300",
    pending: "bg-gray-200",
    locked: "bg-gray-200"
  };

  const connectorFillPercent = (index: number) => {
    const localProgress = Math.max(0, Math.min(1, progress - index));
    return `${localProgress * 100}%`;
  };
</script>

<div
  class={[
    "flex h-full flex-row rounded border border-gray-200 bg-white p-2 md:flex-col",
    className
  ]}
>
  <div
    class="mb-1 hidden px-1 text-[11px] font-semibold tracking-wide text-gray-500 uppercase md:block"
  >
    Progress
  </div>
  <div class="flex-1 px-1 py-1">
    <div class="flex h-full w-full flex-row items-stretch md:flex-col">
      {#each steps as step, i (step.id)}
        <button
          type="button"
          class={[
            "w-full flex-1 truncate rounded border px-2 py-1 text-[10px] font-semibold uppercase transition-colors md:flex-none",
            chipClass[step.status],
            step.clickable ? "cursor-pointer" : "cursor-default"
          ]}
          disabled={!step.clickable}
          title={`${step.label} (${statusText[step.status]})`}
          aria-label={`${step.label} (${statusText[step.status]})`}
          onclick={() => step.clickable && onStepClick?.(step)}
        >
          {step.label}
        </button>
        {#if i < steps.length - 1}
          <div
            class="relative flex min-h-0 min-w-2 flex-1 flex-row items-center justify-center px-0.5 py-0 md:min-h-1 md:min-w-0 md:flex-col md:px-0 md:py-0.5"
          >
            <div
              class={["h-0.5 w-full md:h-full md:w-0.5", connectorClass[steps[i + 1].status]]}
            ></div>
            <div
              class="connector-fill absolute top-0 left-0 bg-sky-500"
              style="--fill-pct: {connectorFillPercent(i)}"
            ></div>
          </div>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .connector-fill {
    width: var(--fill-pct);
    height: 2px;
    transition: width 75ms linear;
  }
  @media (min-width: 768px) {
    .connector-fill {
      width: 2px;
      height: var(--fill-pct);
      transition: height 75ms linear;
    }
  }
</style>

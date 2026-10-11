<script lang="ts">
  // File: packages/views/src/ProblemList.svelte
  //
  // Agda's errors and warnings, in its words: the inspector's problem
  // list, moved from the page (src/routes/+page.svelte, as changed for
  // issue 17) into the views package (issue 62).

  import { CircleAlert, TriangleAlert } from "@lucide/svelte";
  import type { Problem } from "./types";

  interface Props {
    problems: Problem[];
  }

  let { problems }: Props = $props();
</script>

<div class="problem-list">
  {#each problems as problem}<article
      class:error={problem.severity === "error"}
      class:warning={problem.severity === "warning"}
      class="problem-card"
    >
      {#if problem.severity === "error"}<CircleAlert
          size={17}
        />{:else}<TriangleAlert size={17} />{/if}
      <div>
        <strong>{problem.severity}</strong>
        <pre>{problem.message}</pre>
      </div>
    </article>{/each}
</div>

<style>
  .problem-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .problem-card {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 11px;
    border: 1px solid;
    border-radius: 0;
    background: var(--card-surface);
  }
  .problem-card.error {
    border-color: var(--error-card-line);
    color: var(--error);
  }
  .problem-card.warning {
    border-color: var(--warning-card-line);
    color: var(--warning);
  }
  .problem-card :global(svg) {
    flex: none;
  }
  .problem-card strong {
    display: block;
    margin-bottom: 6px;
    font-size: 9px;
    text-transform: uppercase;
  }
  .problem-card pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--problem-text);
    font:
      10px/1.65 JuliaMono,
      monospace;
  }
</style>

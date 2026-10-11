<script lang="ts">
  // File: packages/views/src/GoalList.svelte
  //
  // The open goals, each with its type, and the context of the selected
  // one: the inspector's goal list, moved from the page (src/routes/
  // +page.svelte, as changed for issue 17) into the views package (issue
  // 62).  It takes its data and reports a selection; it asks Agda nothing.

  import { ChevronDown } from "@lucide/svelte";
  import type { ContextEntry, GoalSummary } from "./types";

  interface Props {
    goals: GoalSummary[];
    /** The selected goal's number. */
    active?: number;
    /** The selected goal's context, when it is known. */
    context?: ContextEntry[];
    onselect: (id: number) => void;
  }

  let { goals, active, context = [], onselect }: Props = $props();
</script>

{#if goals.length}
  <div class="goal-list">
    {#each goals as goal}<button
        class:active={active === goal.id}
        class="goal-card"
        onclick={() => onselect(goal.id)}
        ><span class="goal-number">{goal.id}</span><span class="goal-content"
          ><code>{goal.type ?? "?"}</code></span
        ><ChevronDown size={15} class="goal-chevron" /></button
      >{/each}
  </div>
  {#if context.length}<section class="context-panel">
      <h3>Context</h3>
      {#each context as entry}<div class="context-row">
          <code class="context-name">{entry.name}</code><span>:</span><code
            >{entry.type}</code
          >
        </div>{/each}
    </section>{/if}
{/if}

<style>
  .goal-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .goal-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 11px;
    border: 1px solid var(--line);
    border-radius: 0;
    background: var(--card-surface);
    text-align: left;
    cursor: pointer;
  }
  .goal-card:hover {
    border-color: var(--card-hover-line);
  }
  .goal-card.active {
    border-color: var(--card-active-line);
    border-left: 3px solid var(--accent);
  }
  .goal-number {
    display: grid;
    place-items: center;
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 0;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font:
      700 11px JuliaMono,
      monospace;
  }
  .goal-content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .goal-content code {
    overflow-wrap: anywhere;
    color: var(--goal-text);
    font:
      11px/1.5 JuliaMono,
      monospace;
  }
  .goal-card :global(.goal-chevron) {
    flex: none;
    margin-left: auto;
    color: var(--faint);
    transform: rotate(-90deg);
  }
  .context-panel {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .context-panel h3 {
    margin: 0 0 8px;
    color: var(--inspector-heading);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .context-row {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 6px;
    padding: 7px 4px;
    border-bottom: 1px solid var(--editor-line);
    color: var(--muted);
    font-size: 10px;
  }
  .context-row code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      10px/1.5 JuliaMono,
      monospace;
    color: var(--context-text);
  }
  .context-row .context-name {
    color: var(--accent-strong);
    font-weight: 700;
  }
</style>

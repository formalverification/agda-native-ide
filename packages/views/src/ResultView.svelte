<script lang="ts">
  // File: packages/views/src/ResultView.svelte
  //
  // Agda's answer to the last question (a type, a normal form, a context,
  // an error), and its running info, the compiler log: the inspector's
  // result, moved from the page (src/routes/+page.svelte, as changed for
  // issue 17) into the views package (issue 62).

  import type { Result } from "./types";

  interface Props {
    result: Result | null;
    /** Agda's running info, in order. */
    log: string[];
  }

  let { result, log }: Props = $props();
</script>

{#if result}<div class="result-card">
    <span class="result-kind">{result.kind}</span>
    <h2>{result.title}</h2>
    <pre>{result.body}</pre>
  </div>{/if}
{#if log.length}<section class="compiler-log">
    <h3>Compiler log</h3>
    <pre>{log.join("")}</pre>
  </section>{/if}

<style>
  .result-card {
    border: 1px solid var(--line);
    border-radius: 0;
    background: var(--card-surface);
    padding: 14px;
  }
  .result-kind {
    padding: 3px 6px;
    border-radius: 0;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .result-card h2 {
    margin: 12px 0 8px;
    font-size: 13px;
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      11px/1.65 JuliaMono,
      monospace;
  }
  .compiler-log {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .compiler-log h3 {
    margin: 0 0 8px;
    color: var(--inspector-heading);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .compiler-log pre {
    max-height: 220px;
    overflow: auto;
    color: var(--muted);
    font-size: 10px;
  }
</style>

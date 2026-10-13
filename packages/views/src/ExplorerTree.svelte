<script lang="ts">
  // File: packages/views/src/ExplorerTree.svelte
  //
  // The Explorer's tree (issue 9): the items a host gives it, as an ARIA
  // tree with a filter above it.  The DOM is flat, one `treeitem` per row
  // shown, each with its level, its place among its siblings, and
  // `aria-expanded` when it has rows of its own; the tree is one tab stop,
  // whose roving `tabindex` is the row last focused, or the open file's.
  // The keys are the W3C tree view pattern's (./tree.ts, keyAction).  A
  // click on a row, or Enter, selects it and opens what it opens; on a
  // parent's chevron or the indent before it, or on a folder, it shows or
  // hides the parent's rows.  Space selects without opening.  A row that
  // is a folder, or a module that is a folder too, says which in its
  // description.  The filter shows the items whose names or labels hold its
  // every word, with their ancestors; clearing it keeps the row found in
  // view.
  //
  // It takes its data and reports what the reader does: which rows are
  // expanded is the host's to keep (`expanded`, `onexpandedchange`), and so
  // is what opening means (`onopen`).  When the open file (`current`)
  // changes, the tree expands its ancestors, scrolls it into view (when
  // the tree is next shown, if it is hidden), selects it and marks it
  // `aria-current`.  No row is ever disabled: an item the host cannot open
  // now is `aria-disabled`, still focused and read, and not selected.  A
  // focused row that leaves the tree (a "loading" row its rows replace)
  // gives the focus to its parent.
  //
  // The icons are Lucide's (chevron-right, folder, file-text, file-code;
  // ISC, as NOTICE lists @lucide/svelte), drawn as plain SVG: a row of
  // Lucide's components costs two component instances, and opening every
  // row of agda-algebras mounts 351 rows at once.

  import { tick, untrack } from "svelte";
  import {
    filterTerms,
    findItem,
    findPath,
    keyAction,
    treeRows,
    typeAhead,
    type TreeItem,
    type TreeRow,
  } from "./tree";

  interface Props {
    /** The tree's accessible name. */
    label: string;
    items: TreeItem[];
    /** The ids of the rows whose rows are shown. */
    expanded: readonly string[];
    /** The open file's path. */
    current?: string;
    /** The filter's accessible name, and its placeholder. */
    filterLabel?: string;
    placeholder?: string;
    onexpandedchange: (expanded: string[]) => void;
    /** A row that opens a file was activated. */
    onopen?: (item: TreeItem) => void;
    /** The reader selected a row (a click, Enter or Space).  The open
     * file's row, which the tree selects when it reveals it, is not
     * reported: the host knows its own file. */
    onselect?: (item: TreeItem) => void;
  }

  let {
    label,
    items,
    expanded,
    current,
    filterLabel = `Filter ${label}`,
    placeholder = "Filter by name",
    onexpandedchange,
    onopen,
    onselect,
  }: Props = $props();

  const uid = $props.id();
  let tree = $state<HTMLUListElement>();
  let query = $state("");
  /** While filtering, the parents the reader closed; each new filter opens
   * them all again. */
  let closedWhileFiltering = $state<ReadonlySet<string>>(new Set());
  let active = $state<string | undefined>();
  let selected = $state<string | undefined>();
  let typed = "";
  let typedAt = 0;
  /** The open file the tree last revealed. */
  let revealed: string | undefined;
  /** A row to scroll into view once the tree is shown. */
  let pendingScroll: string | undefined;
  /** Whether the focus is in the tree, or was when its row left it. */
  let hadFocus = false;
  /** The rows shown before the last change, for a vanished row's parent. */
  let previousRows: TreeRow[] = [];
  let filtering = false;

  const open = $derived(new Set(expanded));
  const terms = $derived(filterTerms(query));
  const view = $derived(
    terms.length
      ? treeRows(items, (id) => !closedWhileFiltering.has(id), terms)
      : treeRows(items, (id) => open.has(id)),
  );
  const rows = $derived(view.rows);
  /** The row that takes the tree's tab stop. */
  const tabStop = $derived.by(() => {
    if (active !== undefined && rows.some((row) => row.item.id === active)) return active;
    return rows.find((row) => current !== undefined && row.item.path === current)?.item.id ?? rows[0]?.item.id;
  });

  $effect(() => {
    const path = current;
    const found = path === undefined ? undefined : findPath(items, path);
    if (!found || revealed === path) return;
    revealed = path;
    untrack(() => {
      const missing = found.ancestors.filter((id) => !open.has(id));
      if (missing.length) onexpandedchange([...expanded, ...missing]);
      // Under a filter, a parent the reader closed there yields too.
      if (found.ancestors.some((id) => closedWhileFiltering.has(id)))
        closedWhileFiltering = new Set([...closedWhileFiltering].filter((id) => !found.ancestors.includes(id)));
      selected = found.item.id;
      if (!tree?.contains(document.activeElement)) active = found.item.id;
    });
    void tick().then(() => scrollToRow(found.item.id));
  });

  // Clearing the filter keeps the row found (focused or selected) in view.
  $effect(() => {
    const now = terms.length > 0;
    if (filtering && !now) untrack(keepFound);
    filtering = now;
  });

  // A row hidden when it was to be revealed is scrolled to when the tree
  // is shown (the host hid it, or the screen was narrow).
  $effect(() => {
    if (!tree || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pendingScroll !== undefined) scrollToRow(pendingScroll);
    });
    observer.observe(tree);
    return () => observer.disconnect();
  });

  // A focused row that left the tree gives the focus to its parent.
  $effect(() => {
    const now = rows;
    untrack(() => {
      const lost =
        hadFocus &&
        active !== undefined &&
        !now.some((row) => row.item.id === active) &&
        (document.activeElement === null || document.activeElement === document.body);
      if (lost) {
        const parent = previousRows.find((row) => row.item.id === active)?.parent;
        const target = now.some((row) => row.item.id === parent) ? parent : tabStop;
        if (target !== undefined) void tick().then(() => focusRow(target));
      }
      previousRows = now;
    });
  });

  function scrollToRow(id: string) {
    const row = element(id);
    if (row && row.getClientRects().length > 0) {
      row.scrollIntoView({ block: "nearest" });
      pendingScroll = undefined;
    } else pendingScroll = id;
  }

  function keepFound() {
    // The focused row, or else the selected one: a focused row may have
    // left the tree since.
    const found = [active, selected]
      .map((id) => (id === undefined ? undefined : findItem(items, (item) => item.id === id)))
      .find((candidate) => candidate !== undefined);
    if (!found) return;
    const missing = found.ancestors.filter((ancestor) => !open.has(ancestor));
    if (missing.length) onexpandedchange([...expanded, ...missing]);
    void tick().then(() => scrollToRow(found.item.id));
  }

  function element(id: string) {
    return tree?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? undefined;
  }

  function focusRow(id: string) {
    active = id;
    element(id)?.focus();
  }

  function setExpanded(ids: readonly string[], value: boolean) {
    if (terms.length) {
      const next = new Set(closedWhileFiltering);
      for (const id of ids) value ? next.delete(id) : next.add(id);
      closedWhileFiltering = next;
    } else if (value) onexpandedchange([...expanded, ...ids.filter((id) => !open.has(id))]);
    else onexpandedchange(expanded.filter((id) => !ids.includes(id)));
  }

  /** Select a row: not a message, nor one the host cannot open now. */
  function select(row: TreeRow) {
    if (row.item.kind === "message" || row.item.kind === "error" || row.item.disabled) return;
    selected = row.item.id;
    onselect?.(row.item);
  }

  function activate(row: TreeRow) {
    if (row.item.disabled) return;
    select(row);
    if (row.item.path) onopen?.(row.item);
    else if (row.expanded !== undefined) setExpanded([row.item.id], !row.expanded);
  }

  /** The row an event happened in. */
  function rowOf(event: Event) {
    return (event.target as Element | null)?.closest("[data-id]")?.getAttribute("data-id") ?? undefined;
  }

  /** Focus that reached a row some other way than the keys and clicks
   * here (assistive technology, a script) makes it the tab stop. */
  function onfocusin(event: FocusEvent) {
    hadFocus = true;
    const id = rowOf(event);
    if (id !== undefined) active = id;
  }

  /** Focus that moves out of the tree; not a focused row removed from it,
   * which the effect above answers. */
  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && tree?.contains(next)) return;
    const left = event.target as Node;
    queueMicrotask(() => {
      if (left.isConnected) hadFocus = false;
    });
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const id = rowOf(event) ?? tabStop;
    if (id === undefined) return;
    const action = keyAction(rows, id, event.key);
    const row = rows.find((candidate) => candidate.item.id === id);
    if (action.kind === "none") {
      if (event.key.length !== 1 || event.key === " ") return (typed = "");
      const now = performance.now();
      typed = now - typedAt < 700 ? typed + event.key : event.key;
      typedAt = now;
      const next = typeAhead(rows, id, typed);
      if (next !== undefined) focusRow(next);
      event.preventDefault();
      return;
    }
    event.preventDefault();
    typed = "";
    if (action.kind === "focus") focusRow(action.id);
    else if (action.kind === "expand") setExpanded(action.ids, true);
    else if (action.kind === "collapse") setExpanded([action.id], false);
    else if (action.kind === "activate" && row) activate(row);
    else if (action.kind === "select" && row) select(row);
  }

  /** A click: on a parent's chevron, or the indent before it (a target as
   * wide as the row's level), it shows or hides the rows; elsewhere it is
   * Enter. */
  function onclick(event: MouseEvent, row: TreeRow) {
    typed = "";
    focusRow(row.item.id);
    const target = event.currentTarget as HTMLElement;
    const after = target.querySelector(".icon, .label")?.getBoundingClientRect().left ?? -Infinity;
    if (row.expanded !== undefined && (event.clientX < after || (event.target as Element).closest(".chevron")))
      setExpanded([row.item.id], !row.expanded);
    else activate(row);
  }

  /** What a parent is, for a screen reader: a folder, or a module that is
   * a folder too, which Enter opens rather than expands; the id of the
   * hidden text that says so. */
  function description(row: TreeRow) {
    if (row.item.kind === "folder") return `${uid}-folder`;
    if (row.item.kind === "module" && row.item.children?.length) return `${uid}-module-folder`;
    return undefined;
  }

  function onfilterkey(event: KeyboardEvent) {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      query = "";
    } else if ((event.key === "ArrowDown" || event.key === "Enter") && rows.length) {
      event.preventDefault();
      const first = rows.find((row) => row.found && row.item.path) ?? rows[0];
      focusRow(first.item.id);
    }
  }

  function matchCount(count: number) {
    return count === 0 ? "No match" : `${count} ${count === 1 ? "match" : "matches"}`;
  }

  /** A label cut at the filter's hits, for marking them. */
  function pieces(row: TreeRow): Array<{ text: string; hit: boolean }> {
    const text = row.item.label;
    const out: Array<{ text: string; hit: boolean }> = [];
    let at = 0;
    for (const [from, to] of row.hits) {
      if (from < at) continue;
      if (from > at) out.push({ text: text.slice(at, from), hit: false });
      out.push({ text: text.slice(from, to), hit: true });
      at = to;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
  }
</script>

<div class="explorer-tree">
  <input
    class="tree-filter"
    type="search"
    bind:value={query}
    oninput={() => (closedWhileFiltering = new Set())}
    onkeydown={onfilterkey}
    {placeholder}
    aria-label={filterLabel}
    aria-controls={`${uid}-tree`}
    autocomplete="off"
    spellcheck="false"
  />
  <div class="tree-status" role="status">{terms.length ? matchCount(view.matches) : ""}</div>
  <span id={`${uid}-folder`} hidden>folder</span>
  <span id={`${uid}-module-folder`} hidden>module and folder</span>
  <ul class="tree" role="tree" id={`${uid}-tree`} aria-label={label} bind:this={tree} {onkeydown} {onfocusin} {onfocusout}>
    {#each rows as row (row.item.id)}
      <li
        role="treeitem"
        class={`row ${row.item.kind}`}
        class:selected={selected === row.item.id}
        class:current={current !== undefined && row.item.path === current}
        data-id={row.item.id}
        aria-level={row.level}
        aria-setsize={row.setsize}
        aria-posinset={row.posinset}
        aria-expanded={row.expanded}
        aria-selected={selected === row.item.id ? true : undefined}
        aria-current={current !== undefined && row.item.path === current ? true : undefined}
        aria-disabled={row.item.disabled ? true : undefined}
        aria-describedby={description(row)}
        tabindex={row.item.id === tabStop ? 0 : -1}
        title={row.item.title}
        style={`padding-left: ${4 + (row.level - 1) * 10}px`}
        onclick={(event) => onclick(event, row)}
      >
        <svg class="chevron" class:open={row.expanded} viewBox="0 0 24 24" aria-hidden="true"
          >{#if row.expanded !== undefined}<path d="m9 18 6-6-6-6" />{/if}</svg
        >{#if row.item.kind === "folder"}<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"
            ><path
              d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
            /></svg
          >{:else if row.item.kind === "module" || row.item.kind === "file"}<svg
            class="icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            ><path
              d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
            /><path d="M14 2v5a1 1 0 0 0 1 1h5" />{#if row.item.kind === "module"}<path d="M10 9H8" /><path
                d="M16 13H8"
              /><path d="M16 17H8" />{:else}<path d="M10 12.5 8 15l2 2.5" /><path d="m14 12.5 2 2.5-2 2.5" />{/if}</svg
          >{/if}<span class="label"
          >{#each pieces(row) as piece}{#if piece.hit}<mark>{piece.text}</mark>{:else}{piece.text}{/if}{/each}</span
        >{#if row.item.mark}<span class="mark" title={row.item.mark}></span>{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .explorer-tree {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .tree-filter {
    margin: 0 8px 4px;
    padding: 4px 7px;
    border: 1px solid var(--line);
    border-radius: 0;
    outline: 0;
    color: var(--text);
    background: var(--surface);
    font-size: 11px;
  }
  .tree-filter:focus-visible {
    border-color: var(--focus-ring);
  }
  .tree-status {
    padding: 0 12px;
    color: var(--muted);
    font-size: 10px;
  }
  .tree {
    min-height: 0;
    flex: 1;
    margin: 0;
    padding: 0 0 12px;
    overflow-x: hidden;
    overflow-y: auto;
    list-style: none;
  }
  .row {
    position: relative;
    height: 26px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 8px;
    color: var(--explorer-text);
    font-size: 11px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }
  .row:hover {
    background: var(--explorer-hover-surface);
  }
  .row:focus-visible {
    outline: 1px solid var(--focus-ring);
    outline-offset: -1px;
  }
  .row.section {
    height: 27px;
    color: var(--explorer-heading);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .row.message,
  .row.error {
    color: var(--muted);
    cursor: default;
  }
  .row.error {
    color: var(--error);
  }
  .row.selected {
    background: var(--explorer-active-surface);
  }
  .row.current {
    color: var(--accent-strong);
    background: var(--chapter-active-surface);
  }
  /* The page's stylesheet sets every box-shadow to none, so the open
     file's bar is drawn as the activity bar's is. */
  .row.current::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 2px;
    background: var(--accent);
  }
  .row[aria-disabled="true"] {
    opacity: 0.45;
    cursor: not-allowed;
  }
  svg {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .chevron {
    width: 13px;
    height: 13px;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .icon {
    width: 14px;
    height: 14px;
    color: var(--chapter-icon);
  }
  .row.file .icon {
    color: var(--accent);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  mark {
    color: var(--accent-strong);
    background: var(--accent-soft);
  }
  /* Forced colors drop the surfaces: the selected row takes the system's
     selection, and the open file's bar its text color. */
  @media (forced-colors: active) {
    .row.selected {
      forced-color-adjust: none;
      color: SelectedItemText;
      background: SelectedItem;
    }
    .row.current::before {
      forced-color-adjust: none;
      background: CanvasText;
    }
  }
  .mark {
    width: 6px;
    height: 6px;
    flex: none;
    margin-left: auto;
    border-radius: 50%;
    background: var(--saved-indicator);
  }
</style>

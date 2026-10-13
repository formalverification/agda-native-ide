// File: packages/views/src/tree.ts
//
// The Explorer's tree as data (issue 9): the items a host gives the tree
// (sections, folders, modules and files), a library's items built from its
// module list, the rows the tree shows (what is expanded, or what a filter
// finds, with their ancestors), and what a key does there, as the W3C's
// tree view pattern says: Up and Down between the rows shown, Right opens
// a closed parent or enters an open one, Left closes an open parent or
// goes to the parent, Home and End, `*` opens a row's siblings, Enter
// activates, and a printable character moves to a row whose label starts
// with what was typed (typeAhead).  Plain functions of plain data, which the
// component (ExplorerTree.svelte) renders and a test can drive.

/** What a row is: a section of the Explorer (the playground, a library), a
 * folder, a module (which may also be a folder, when a folder beside it
 * has its name), a file, or a message in place of a section's rows, which
 * says it is loading them, or why it could not (an error). */
export type TreeKind = "section" | "folder" | "module" | "file" | "message" | "error";

export interface TreeItem {
  /** Unique in the tree; the key the host remembers expansion by. */
  id: string;
  /** What the row shows. */
  label: string;
  kind: TreeKind;
  /** The file it opens, as a path on the engine's drive. */
  path?: string;
  /** What the filter matches, with the label: a module's dotted name, or
   * a file's.  An item without one is shown, while filtering, only as an
   * ancestor. */
  name?: string;
  /** What hovering shows. */
  title?: string;
  /** Shown and focusable, but not opened now (`aria-disabled`). */
  disabled?: boolean;
  /** A dot after the label, whose text says what it marks. */
  mark?: string;
  children?: TreeItem[];
}

/** A module as a library's module list gives it. */
export interface ModuleEntry {
  name: string;
  path: string;
  title?: string;
}

/** A library's items, from its module list in the Explorer's order:
 * folders as parents, modules as rows, and a folder beside a module of its
 * own name as the module's row, with the folder's rows as its children.
 * Every id starts with `prefix`. */
export function moduleTree(modules: readonly ModuleEntry[], prefix: string): TreeItem[] {
  const roots: TreeItem[] = [];
  const byName = new Map<string, TreeItem>();
  const childrenOf = (parent: string) => (parent ? (byName.get(parent)!.children ??= []) : roots);
  for (const entry of modules) {
    const parts = entry.name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join(".");
      if (byName.has(name)) continue;
      const folder: TreeItem = { id: `${prefix}${name}`, label: parts[i - 1], kind: "folder", title: `${name}.*` };
      byName.set(name, folder);
      childrenOf(parts.slice(0, i - 1).join(".")).push(folder);
    }
    const module: TreeItem = {
      id: `${prefix}${entry.name}`,
      label: parts[parts.length - 1],
      kind: "module",
      path: entry.path,
      name: entry.name,
      title: entry.title ? `${entry.name}\n${entry.title}` : entry.name,
    };
    const folder = byName.get(entry.name);
    // A folder listed before its module (a list out of order): the module
    // takes the folder's place, and its rows.
    if (folder) Object.assign(folder, module, { children: folder.children });
    else {
      byName.set(entry.name, module);
      childrenOf(parts.slice(0, -1).join(".")).push(module);
    }
  }
  return roots;
}

/** A row the tree shows. */
export interface TreeRow {
  item: TreeItem;
  /** 1 for a section. */
  level: number;
  /** Among the rows shown under the same parent. */
  setsize: number;
  posinset: number;
  /** The parent's id. */
  parent?: string;
  /** Whether its rows are shown; undefined for a row that has none (here). */
  expanded?: boolean;
  /** Whether the filter found it, rather than one of its rows. */
  found: boolean;
  /** The parts of the label the filter matched, as [from, to). */
  hits: Array<[number, number]>;
}

/** The words of a filter: each must be part of an item's name or of its
 * label, case aside. */
export function filterTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether every term is part of an item's own name or of its label, as
 * the row shows it (a file's name and extension). */
function matches(item: TreeItem, terms: readonly string[]): boolean {
  const name = item.name?.toLowerCase();
  const label = item.label.toLowerCase();
  return name !== undefined && terms.every((term) => name.includes(term) || label.includes(term));
}

/** Where each term first falls in a label. */
function hitsIn(label: string, terms: readonly string[]): Array<[number, number]> {
  const lower = label.toLowerCase();
  const hits: Array<[number, number]> = [];
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0) hits.push([at, at + term.length]);
  }
  return hits.sort((a, b) => a[0] - b[0]);
}

/**
 * The rows shown, in order.  With no terms: every root, and the children
 * of every row `isExpanded` names.  With terms: the items with a name whose
 * name or label holds each of them, with their ancestors, and nothing else,
 * each parent's rows
 * shown unless `isExpanded` says otherwise.  `matches` counts the items
 * found that open a file.
 */
export function treeRows(
  roots: readonly TreeItem[],
  isExpanded: (id: string) => boolean,
  terms: readonly string[] = [],
): { rows: TreeRow[]; matches: number } {
  const rows: TreeRow[] = [];
  let found = 0;
  // While filtering, the items kept: each match and its ancestors.
  const kept = new Set<TreeItem>();
  if (terms.length) {
    const keep = (item: TreeItem): boolean => {
      let any = false;
      for (const child of item.children ?? []) any = keep(child) || any;
      const self = matches(item, terms);
      if (self && item.path) found += 1;
      if (self || any) kept.add(item);
      return self || any;
    };
    roots.forEach(keep);
  }
  const shown = (items: readonly TreeItem[]) => (terms.length ? items.filter((item) => kept.has(item)) : items);
  const walk = (items: readonly TreeItem[], level: number, parent?: string) => {
    const siblings = shown(items);
    siblings.forEach((item, index) => {
      const children = shown(item.children ?? []);
      const expanded = children.length ? isExpanded(item.id) : undefined;
      rows.push({
        item,
        level,
        setsize: siblings.length,
        posinset: index + 1,
        parent,
        expanded,
        found: terms.length > 0 && matches(item, terms),
        hits: terms.length ? hitsIn(item.label, terms) : [],
      });
      if (expanded) walk(children, level + 1, item.id);
    });
  };
  walk(roots, 1);
  return { rows, matches: found };
}

/** The first item `wanted` holds of, depth first, and the ids of its
 * ancestors, outermost first. */
export function findItem(
  roots: readonly TreeItem[],
  wanted: (item: TreeItem) => boolean,
): { item: TreeItem; ancestors: string[] } | undefined {
  const search = (items: readonly TreeItem[], ancestors: string[]): ReturnType<typeof findItem> => {
    for (const item of items) {
      if (wanted(item)) return { item, ancestors };
      const found = item.children && search(item.children, [...ancestors, item.id]);
      if (found) return found;
    }
    return undefined;
  };
  return search(roots, []);
}

/** The item that opens `path`, and its ancestors. */
export function findPath(roots: readonly TreeItem[], path: string) {
  return findItem(roots, (item) => item.path === path);
}

/** What a key does in the tree. */
export type TreeAction =
  | { kind: "focus"; id: string }
  | { kind: "expand"; ids: string[] }
  | { kind: "collapse"; id: string }
  | { kind: "activate"; id: string }
  | { kind: "select"; id: string }
  | { kind: "none" };

/** What `key` does with the row `active` focused. */
export function keyAction(rows: readonly TreeRow[], active: string, key: string): TreeAction {
  const index = rows.findIndex((row) => row.item.id === active);
  const row = rows[index];
  const focus = (target: TreeRow | undefined): TreeAction =>
    target ? { kind: "focus", id: target.item.id } : { kind: "none" };
  if (!row) return focus(rows[0]);
  switch (key) {
    case "ArrowDown":
      return focus(rows[index + 1]);
    case "ArrowUp":
      return focus(rows[index - 1]);
    case "Home":
      return focus(rows[0]);
    case "End":
      return focus(rows[rows.length - 1]);
    case "ArrowRight":
      if (row.expanded === false) return { kind: "expand", ids: [row.item.id] };
      return row.expanded ? focus(rows[index + 1]) : { kind: "none" };
    case "ArrowLeft":
      if (row.expanded) return { kind: "collapse", id: row.item.id };
      return focus(rows.find((other) => other.item.id === row.parent));
    case "*": {
      const ids = rows
        .filter((other) => other.parent === row.parent && other.expanded === false)
        .map((other) => other.item.id);
      return ids.length ? { kind: "expand", ids } : { kind: "none" };
    }
    case "Enter":
      return { kind: "activate", id: row.item.id };
    case " ":
      return { kind: "select", id: row.item.id };
    default:
      return { kind: "none" };
  }
}

/** The first row, wrapping, whose label starts with `typed`, case aside:
 * from the row after `active` for one letter, or a letter repeated (which
 * steps through the rows that start with it); from `active` itself for a
 * longer prefix, so that typing on along a label stays on its row. */
export function typeAhead(rows: readonly TreeRow[], active: string, typed: string): string | undefined {
  const start = rows.findIndex((row) => row.item.id === active);
  const prefix = typed.toLowerCase();
  // A repeated letter steps through the rows that start with it.
  const repeated = prefix.length > 1 && [...prefix].every((letter) => letter === prefix[0]);
  const wanted = repeated ? prefix[0] : prefix;
  const from = repeated || prefix.length === 1 ? 1 : 0;
  for (let step = from; step < rows.length + from; step++) {
    const row = rows[(start + step + rows.length) % rows.length];
    if (row.item.label.toLowerCase().startsWith(wanted)) return row.item.id;
  }
  return undefined;
}

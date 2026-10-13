<!-- File: docs/notes/explorer.md -->

# The Explorer

This note explains the page's Explorer ([#9]): the list of agda-algebras'
modules that the build writes, and the tree that shows it beside the
playground's file and PLFA's chapters.  The fork's Explorer was two
hard-coded levels, a PLAYGROUND row and PLFA's parts and chapters, every
row disabled while Agda was busy, and hidden at 800 px; the site has
mounted agda-algebras' sources since [#11], so every module is on the
drive, and what was missing was a list of them and a tree to show it.
Opening a library module is [#10]'s; this tree selects one.  Every figure
is from the runs of 2026-10-13 in
[`docs/measurements/explorer-2026-10-13.json`][record], with the machine
and its load.

## The module list

The page cannot list the sources archive it mounts: the engine hands the
archive's bytes to the worker, whose interface has no call that lists the
drive.  So the build writes the list, as
`static/agda-algebras-modules.json`, one line of JSON, as follows:

```json
{"version":1,"library":"agda-algebras",
 "commit":"f067d57d367a4830834ce1fd80937820754f9a28",
 "include":["/agda-algebras/src"],
 "modules":[
  {"name":"agda-algebras",
   "path":"/agda-algebras/src/agda-algebras.lagda.md",
   "title":"agda-algebras (The Agda Universal Algebra Library)"},
  ...]}
```

+  **Where it comes from**.  `scripts/library-modules.mjs` reads a sources
   archive with node's zlib alone (a zip's central directory, each entry
   stored or deflated and checked against its CRC-32), finds the archive's
   one `.agda-lib`, and lists every source under the directories its
   `include:` names, by the engine's suffixes (`.agda`, `.lagda.md` and
   the other literate kinds).  A module's name is its path under the
   included directory, the suffix dropped and the slashes read as dots;
   its path is its path in the archive, which the page extracts at the
   drive's root.  The flake runs it as a derivation of its own,
   `mkAgdaAlgebrasModules`, on `mkAgdaAlgebrasSources`' archive, with the
   commit `agdaAlgebras` pins, and `nix build .#assets` installs the
   result.  Being its own derivation, it leaves the archive's derivation,
   and the interfaces and the gate built from it, unchanged.
+  **The titles** are the `title` of each module's front matter, a YAML
   block opening its first line, which agda-algebras writes `title:` or
   `title :`, in double quotes.  At the pin, 349 of the 350 modules have
   one; `Setoid/Homomorphisms/HomomorphicImages.lagda.md` begins `n---`, a
   stray letter before its front matter, so it has none, and the tree
   shows its name alone.
+  **The order** is the Explorer's: by name segment, case aside first and
   then by code point, a name before the names under it.  So a module comes
   before the modules in the folder of its name (`Setoid`, then
   `Setoid.Algebras`), and `agda-algebras`, the library's title page,
   comes first, where code-point order would put it after every capital.
   The tree shows the rows in the list's order and sorts nothing itself.
+  **The checks**.  `@agda-native-ide/manifest` validates the list
   (`parseLibraryManifest`): each name must be the module at its path,
   under an included directory, no name may come twice, and the modules
   must be in the Explorer's order; it names the first field that is
   wrong.  `make assets-check`, which `make build` runs (in the Nix
   sandbox too, where `nix build .#site` runs it), writes the list again
   from `static/agda-algebras-sources.zip` and refuses a list that
   differs, naming the first module where it does.  With `make assets`
   run, the unit tests compare the two as well, and check that the list's
   paths are exactly the archive's `.lagda.md` files.
+  **What it costs**: one request on a first visit, 59,754 bytes (4,985
   gzipped at level 9, 5,034 at level 6), with its cache token, like the
   other assets.  It is left out of the drive cache's namespace, which
   digests what Agda reads, so a new list does not drop a reader's drive.
+  **Why not the archives' index**.  [#12]'s `index.json` also names every
   module with its path, and at the pin agrees with the list exactly: the
   same 350 names, paths and commit (checked 2026-10-13).  But it is built
   from the interfaces, which take 6 to 13 minutes in the Nix sandbox, it
   is 285,618 bytes, it has no titles, and the site does not ship it until
   [#14] mounts the archives.  The list takes seconds, from the sources
   archive alone.

## The tree

The Explorer is one tree, `ExplorerTree` from `@agda-native-ide/views`,
with three sections: the playground (`Main.agda`), agda-algebras (every
module of the list), and PLFA (its chapters by part, until [#20] retires
them).  One tree rather than a library tree beside the old rows: until
[#10] opens a library module, the open file is always the playground's or
a chapter, so only a tree that holds them can reveal the open file and mark
it current today, and the Explorer keeps one tab stop and one set of keys.
The component takes its data and reports what the reader does; the page
keeps which rows are expanded and decides what opening a row means.

+  **The rows**.  A section; a folder; a module; a file; and, in place of a
   section's rows, a message while they load, or an error, in the error
   color, when they could not.  A folder beside a module of its own name is
   one row, the module's, whose chevron shows or hides the folder's rows
   and whose label opens the module: 64 of the 65 folders at the pin.
   `Legacy/` has no module of its name, and is a folder row.  A module's
   row shows the last part of its name, and hovering shows the whole name
   and the title.  With every row open, agda-algebras has 351 rows (350
   modules and `Legacy`), five levels deep under its section (the deepest
   module is at level 6).
+  **The roles**, as the W3C's tree view pattern gives them, with a flat
   DOM: a `tree` labelled "Files"; each row a `treeitem` with
   `aria-level`, `aria-setsize` and `aria-posinset`; `aria-expanded` on a
   row with rows of its own and on no other; `aria-selected` on the
   selected row; `aria-current` on the open file's; and a description,
   "folder" or "module and folder", on a row with rows of its own, since
   Enter opens a module that is a folder too and expands a folder.  The
   tree is one tab stop: the row last focused, by whatever means, or the
   open file's.  A focused row that leaves the tree, as the "loading" row
   does when the modules arrive, gives the focus to its parent.
+  **The keys**: Up and Down move between the rows shown; Right opens a
   closed parent, or moves to an open one's first row; Left closes an open
   parent, or moves to the parent; Home and End go to the first and last
   rows; `*` opens every closed sibling; Enter selects the row and opens
   what it opens (a parent with no file of its own shows or hides its
   rows); Space selects without opening; a printable character moves to
   the next row whose label starts with what was typed, the letters typed
   within 700 ms of each other, and with no other key between them, making
   one prefix.  A click on a chevron, or on the indent before it, shows or
   hides the rows (a target at least 31 px wide on a library's rows);
   anywhere else on a row, it is Enter.
+  **The filter**, above the tree, shows the rows whose names or labels
   hold every word typed, case aside, with their ancestors, the words
   marked in each label; a status line, which a screen reader announces,
   counts the matches.  A module's name is its dotted name, so `alg basic`
   finds `Setoid.Algebras.Basic`; a file's label is its file name, so
   `Main.agda` finds the playground's.  Escape clears it, and Down or Enter
   moves to the first match.  While it filters, every parent of a match is
   open, and closing one lasts until the filter changes.  Clearing it
   keeps the row found in view: the focused row's ancestors, or the
   selected one's, are expanded.
+  **What it remembers**: which rows are expanded, in localStorage under
   `agda-web-ide-beta:explorer:expanded` (a JSON array of row ids).  A
   first visit shows the three sections and PLFA's first part.  When
   storage is refused the tree still opens and closes rows, for that visit.
+  **The open file**.  When the editor's file changes, and on a page's
   first load, the tree opens the file's ancestors, scrolls its row into
   view, and selects it; its row is marked current, with the accent's bar
   at its left edge.  When the tree is hidden at that moment ("Hide files",
   or a narrow screen), the scroll waits until it is shown.  A reader who
   closes an ancestor afterwards keeps it closed until the open file
   changes.
+  **While Agda is busy** no row is disabled, and the keys, the clicks and
   the filter work.  The page opens the playground's file and PLFA's
   chapters only while Agda is idle, as it always has, so those rows are
   `aria-disabled` while it is busy: still focused and read, but neither
   opened nor selected.  A module of agda-algebras never is.  The fork
   disabled every row, so a row with focus lost it at each check.
+  **Small screens**.  The Explorer still hides at 800 px and below, as
   the fork's did; [#22] makes it a drawer.  The tree's rows clip their
   labels rather than widen the Explorer, which scrolls up and down only,
   and the page does not scroll sideways at 400, 768 or 1440 px.

### What the next issues take from it

+  **[#10]** (library modules opened read-only) handles `onopen`, which
   the tree calls with the row's item (`id`, `label`, `kind`, `path`,
   `name`) on Enter or a click on a module, and `onselect`, which it calls
   when the selection moves.  The page's `openFromExplorer` opens the
   playground's file and the chapters, and nothing for a module of
   agda-algebras; once it opens one, the tree reveals it and marks it
   current with no change of its own.
+  **[#22]** (the Explorer as a drawer on a phone) takes the component
   whole: it needs no width of its own, its rows are 26 px high, and its
   filter is an ordinary search field.

## What it costs

Measured on 2026-10-13 on this workstation, in the flake's headless
Chromium 149, at the loads given (other sessions' builds ran beside it, so
the times are indicative and the counts are the findings):

+  **Every row of agda-algebras at once**: closing and reopening its
   section, with every row open, mounts 351 rows.  From the click to the
   frame after it, the reopening took a median of 30 to 31 ms at a load
   near 2, and 37 to 47 ms at a load near 14 (runs of 7 and 11).  Closing
   takes 5 to 7 ms.  When each row drew its two icons as Lucide's
   components, the reopening took 59 to 66 ms at the same quiet load, the
   two builds alternating, which is why the icons are Lucide's paths drawn
   as plain SVG.
+  **The filter**: one letter typed, from the input event to the frame
   after it, a median of 18 to 19 ms for `a` at a load near 2 (345
   matches, 363 rows), and at a load near 14, 21 to 27 ms for `a` or `s`
   and 8 to 9 ms for `h` (45 matches, 70 rows); clearing it, 18 to 36 ms,
   as the rows come back.
+  **The page's first check** is unchanged: eight alternating rounds on
   fresh profiles of `main`'s site and this one, both built by Nix, gave
   medians of 864 and 851 ms to "Agda ready", and 454 and 446 ms for the
   check as the page reports it (load 9 to 12).

## The checks

+  **Unit tests**: the list's script on a constructed archive and on the
   site's (`src/library-modules.test.js`), the list's schema
   (`packages/manifest/src/library.test.ts`), and the tree's logic, rows,
   filter and keys (`packages/views/src/tree.test.ts`), which checks
   agda-algebras' shape on the shipped list: 351 rows, 350 modules, 64 of
   them folders too, and `Legacy` the one folder alone.
+  **The browser check** (`scripts/browser-check/explorer.mjs`) uses the
   tree as a keyboard and screen-reader user would: its roles and their
   attributes; the arrow keys from the tab stop to `Overture.Signatures`,
   Enter selecting it without opening it; every parent opened with Right,
   after which the rows must be the list's modules in its order, each with
   its level, its place among its siblings and its label; a filter; a key
   and the filter while the library import's check runs, in one call
   inside the page (64 ms); after the playground's section is closed and
   the page reloaded, the rows still expanded and `Main.agda` revealed;
   and a PLFA chapter opened from the reader's Next in a closed part,
   which the tree must open and scroll into view (8,472 px down, with every
   row of agda-algebras open).
+  **Controls**: each of the following, made in a copy of the branch and
   built, fails the browser check, with the message given in the record:
   agda-algebras' rows disabled while Agda is busy; the expansion not
   stored; the open file's ancestors not expanded; the reveal not
   scrolling; a module left out of the tree; the keys acting on the tab
   stop while focus moves elsewhere; and `aria-setsize` counting every row
   shown.

[record]: ../measurements/explorer-2026-10-13.json
[#9]: https://github.com/formalverification/agda-native-ide/issues/9
[#10]: https://github.com/formalverification/agda-native-ide/issues/10
[#11]: https://github.com/formalverification/agda-native-ide/issues/11
[#12]: https://github.com/formalverification/agda-native-ide/issues/12
[#14]: https://github.com/formalverification/agda-native-ide/issues/14
[#20]: https://github.com/formalverification/agda-native-ide/issues/20
[#22]: https://github.com/formalverification/agda-native-ide/issues/22

<!-- File: docs/browser.md -->

# In the browser

The playground runs Agda 2.9.0 in a browser tab, with no server behind it:
the type-checker and its language server, compiled to WebAssembly, run in
a worker of the page, and every file they read is fetched from this site.

<p><a class="md-button md-button--primary" href="../play/">Open the playground</a></p>

## What you can do

+  **Write in `Main.agda`**, a module of a project of its own, whose
   library depends on the standard library 2.3 and agda-algebras.  The
   default `Main.agda` carries agda-algebras' options line, `--without-K
   --exact-split --safe`, so a postulate is refused there as the library
   refuses it.  Its first check opens one goal, which the inspector shows
   with its type and context; give, refine, case split, infer and
   normalize answer as Agda's interaction commands do in Emacs.
+  **Browse agda-algebras** in the Explorer: every module of the library,
   as one tree, with the keyboard as a screen reader's user would use it,
   and a filter that finds a module by any part of its dotted name.
+  **Open a module read-only** from the Explorer: hover, Infer and
   Normalize answer in its scope, and no keystroke changes it.  "Copy to
   playground" makes an editable copy, which checks and whose goals answer
   like `Main`'s.
+  **Import any module** of the standard library or agda-algebras.  Before
   it checks, the page works out which of agda-algebras' interface
   archives the imports need, and asks, stating their bytes.  With them,
   only `Main` is type-checked; the browser keeps them, so a second visit
   fetches none.
+  **Read PLFA's chapters**, which the fork carried, until the plugin
   format takes them over ([#20]).

## What it loads, and what it costs

A first visit fetches the page, the compiler's gzip, Agda's builtin
library, the standard library and agda-algebras' sources; agda-algebras'
interfaces are fetched only for an import, and only after you agree.  The
figures, each from the run its design record cites, are the following:

+  **The first visit**: 25 files, 16,126,490 bytes, of which the compiler's
   gzip is 11,119,315 (headless Chromium 149, 2026-10-07, before the
   playground's project added agda-algebras' sources); ADR 0001
   [§ 7](adr/0001-runtime.md#7-the-290-compiler).
+  **The playground's project**: one more request on a first visit, the
   sources archive of 985,864 bytes; the first check of the default `Main`
   in 0.40 s by the page's own count; ADR 0001
   [§ 11](adr/0001-runtime.md#11-the-playgrounds-project).
+  **An import, with the archives**: `open import Overture.Signatures`
   asks for 206,933 bytes (3 archives holding 11 modules) and then
   type-checks `Main` alone; then `Setoid.Varieties.HSP` asks once for
   39,044,608 bytes (the 125 archives not yet mounted); ADR 0001
   [§ 12](adr/0001-runtime.md#12-mounting-what-the-imports-need).
+  **The same import, without them**: Agda checks the closure from source,
   which takes minutes (`Setoid.Algebras.Basic`, 170 modules, 1 min 38 s to
   6 min 32 s over six runs); ADR 0001
   [§ 11](adr/0001-runtime.md#11-the-playgrounds-project).

GitHub Pages serves every file with `max-age=600`, so the compiler, the
libraries and the archives are named by a token derived from their
content: a deploy that changes one changes its URL, and a revisit costs a
revalidation, never a stale file.  The page needs no particular headers
and no service worker: it shares no memory between threads, so it does
not need cross-origin isolation ([§ 8](adr/0001-runtime.md#8-the-reactor-and-the-drive-in-one-worker)).

## Browsers

The page is tested in the browsers below, and others are not supported: in
a browser that lacks what the page needs, the page says what is missing
and where it is tested, and works around nothing.

| Browser | How it is tested | Last passed |
|---|---|---|
| Chromium, headless (149, the flake's) | The browser check, on every pull request, served with and without the isolation headers, and the page's notices | 2026-10-08, and on each pull request since |
| Firefox, headless (157) | The same checks, by hand | 2026-10-08 |

Safari is untested.  Before it starts Agda, the page checks for module
workers, `DecompressionStream`, and the five WebAssembly features the
compiler uses; by MDN's data a browser has them all from Chrome 96,
Firefox 114 and Safari 16.4, which are floors, not a promise.

## What it does not do yet

+  **The Explorer hides at 800 px and below** ([#22]), so on a phone the
   playground is an editor and an inspector.
+  **One library**: the playground's project sees the standard library and
   agda-algebras; other libraries, corpora, models and tools arrive as
   plugins (Milestone 2 of [the plan](GITHUB_PROJECT.md)).
+  **No agents yet**: the tool surface the page will expose to a model is
   Milestone 3, and the model in the loop Milestone 4.

## Its notice

The playground ships code and data under several licenses (the fork's MIT,
the compiler's GHC runtime and GMP, the standard library, agda-algebras,
PLFA's CC BY 4.0, JuliaMono's OFL).  Its notice is
<a href="../play/NOTICE.txt">NOTICE.txt</a>, beside it, with the license
texts it names in `licenses/`, and
[Provenance](provenance.md) says where each file comes from, with its
SHA-256.

[#20]: https://github.com/formalverification/agda-native-ide/issues/20
[#22]: https://github.com/formalverification/agda-native-ide/issues/22

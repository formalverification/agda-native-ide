---
hide:
  - navigation
  - toc
---

<!-- File: docs/index.md -->

# An Agda workbench

<div class="hero" markdown>

<p class="lede">Agda in a browser tab with no server, beside you in VS Code,
and in Emacs: one core, on Agda 2.9.0, in which the type-checker is the
judge and everything else is a plugin.</p>

<div class="actions">
<a class="md-button md-button--primary" href="play/">Open the playground</a>
<a class="md-button" href="each-projects-own-agda/">Each project's own Agda</a>
<a class="md-button" href="adr/0002-where-the-workbench-lives/">Why three platforms</a>
</div>

<figure class="shot">
<img class="only-light" src="assets/screenshots/playground-light.png" width="1440" height="900"
     alt="The playground in its light theme: the Explorer lists agda-algebras' modules, the editor holds Main.agda, and the inspector shows one open goal with its type and context.">
<img class="only-dark" src="assets/screenshots/playground-dark.png" width="1440" height="900"
     alt="The playground in its dark theme: the Explorer lists agda-algebras' modules, the editor holds Main.agda, and the inspector shows one open goal with its type and context.">
<figcaption>The playground, at <a href="play/">play/</a> on this site, after
its first check of the default <code>Main.agda</code>: one open goal, its
type and its context.  The picture is taken by the deploy that published
this page, in headless Chromium, from the files it published.</figcaption>
</figure>

</div>

## Three platforms, one core

<div class="platforms" markdown>

<div markdown>

### In the browser

<span class="state">Works today</span>

Agda 2.9.0 and its language server, compiled to WebAssembly, run in the
tab.  Write in `Main.agda` over the standard library and agda-algebras,
browse every module of agda-algebras in the Explorer, and import any of
them: the page says how many bytes an import needs before it fetches
them.  [In the browser](browser.md)

</div>

<div markdown>

### In VS Code

<span class="state">From source</span>

A companion beside agda-mode-vscode: each project's own Agda in one
window, a panel that follows the active module, and a native engine on
your own checkout, with an interaction lane per project and a fresh Agda
for each verdict.  Not yet published to a marketplace.
[In VS Code](vscode.md)

</div>

<div markdown>

### In Emacs

<span class="state">From source</span>

A package that makes agda2-mode start each buffer's project's own Agda,
so that projects on Agda 2.8.0 and 2.9.0 load in one session, installed
from GitHub; the agent and search tools follow.  [In Emacs](emacs.md)

</div>

</div>

The three share one core, in the repository's `packages/`: an engine that
speaks Agda's interaction protocol behind one interface, with a transport
for the browser's worker and one for a native Agda; a tool surface; a
plugin manifest; and the views.  One conformance suite runs against both
transports and must give the same answers.  [ADR 0003](adr/0003-the-shared-core.md)
records how, and [the overview](engine/overview.md) explains it.

## Each project's own Agda

An editor runs one Agda for every file, so a file of a project pinned to
another Agda, or to other libraries, fails with errors that read as broken
code.  In VS Code and in Emacs, the workbench runs each project's own
Agda instead, as its flake pins it, with no setting touched once you trust
your own checkouts.  [Each project's own Agda](each-projects-own-agda.md)
says how it decides, and what its runs in both editors showed.

## Principles

+  **Agda is the judge**.  A verdict is Agda's exit code, a goal is what
   Agda reports; no view and no model decides that a proof is done.
+  **Nothing leaves the tab without consent**.  The playground fetches
   what it runs from this site, states the bytes of an import's archives
   before it fetches them, and has no analytics; these pages request
   nothing from another origin.
+  **Measurements are the evidence**.  Each figure on these pages names the
   run it comes from: a section of a design record, or a record committed
   beside it.
+  **Every binary is pinned**.  The compiler, the libraries and the fonts
   are fetched by hash or built from pinned sources, and
   [Provenance](provenance.md) says where each comes from.

## Where it comes from

The browser IDE forks [plfa-playground], the browser Agda environment
behind <https://plfa.isotopy.xyz/> (SvelteKit, CodeMirror 6, and the Agda
Language Server compiled to WebAssembly), and its first deliverable is the
agda-algebras IDE, which [agda-algebras]' site is to open from its
"Playground" link.  The design is
[the proposal](notes/browser-ide-proposal.md) carried from
[agda-native-air], whose `agda-mcp` defines the tool contract the workbench
speaks to agents.  [The plan](GITHUB_PROJECT.md) lists the milestones and
their issues.

[plfa-playground]: https://github.com/SeungheonOh/plfa-playground
[agda-algebras]: https://github.com/ualib/agda-algebras
[agda-native-air]: https://formalverification.github.io/agda-native-air/

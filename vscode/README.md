<!-- File: vscode/README.md -->

# Agda Workbench companion

The first VS Code host for agda-native-ide, beside
`banacorn.agda-mode`.  It opens a panel for the active Agda module and
delegates load, give and refine to the mode.  The engine, agent tools and
diagrams follow in [#64], [#65] and [#66].

This is a standalone package because [#62], the shared workspace, is still
open.  That issue will fold `vscode/` into the workspace.  The companion
branches from `main` and needs no code from the drive's pull request.

## The mode's command contract

Read at agda-mode-vscode 0.10.4, commit
`535b3eb8f09132edbad87017562e6cb7aab99a7c`, and exercised against the
installed Marketplace extension of that version in VS Code 1.141.0 with
native Agda 2.9.0.  Its manifest contributes 77 commands.  The reference
points are [command registration][registration], [dispatch][dispatch] and
[response handling][responses].  The companion consumes no activation
exports, test channels, registry entries or returned internal state.

| Command | Input | Document effect | Where the answer goes |
|---|---|---|---|
| `agda-mode.load` | Active editor; arguments ignored | Saves the buffer; a bare `?` can become a braced goal | Goals, errors and running information in the mode's panel; highlighting in the editor |
| `agda-mode.give` | Cursor inside a loaded goal; reads the text inside its braces | On acceptance, removes the braces; the probe changed `ℓ₁ = {! suc 0ℓ !}` to `ℓ₁ = suc 0ℓ` | Errors and goals in the mode's panel |
| `agda-mode.refine` | Cursor inside a loaded goal; reads the text inside its braces | The probe changed `ℓ₁ = {! suc !}` to `ℓ₁ = suc {!   !}` | New goals and errors in the mode's panel |
| `agda-mode.goal-type-and-context[Simplified]` | Cursor inside a loaded goal | No edit | Type and context in the mode's panel |
| `vscode.provideDocumentSemanticTokens` | Document URI, after load | No edit | VS Code's public semantic-token result from the mode's provider |

The mode handlers accept no term or goal-number argument.  Write a term in
the goal and put the cursor there before giving or refining.  Giving an
empty goal opens the mode's own prompt.  Calling a goal command outside a
goal reports the problem in the mode's panel.

In the successful probes, `executeCommand` resolved to a ReScript result
with an `Ok` tag and a private state object.  Dispatch can also return
`undefined` when there is no applicable editor or loaded state.  Neither
is a supported answer format.  The mode catches connection errors and
displays Agda errors itself; a resolved command does not establish that
Agda accepted an edit.  The companion discards this value, then reads the
document's current text and version.  An unchanged buffer is a possible
outcome, not an inferred failure or success.

There is no contributed highlighting command.  Loading requests Agda's
highlighting, and the public VS Code semantic-token command retrieves the
editor's tokens.  These tokens are classifications and ranges, not goal
types, a complete Agda response stream or a verdict.  Queries requiring
those answers belong to the separate native lane in [#64]; [#69] asks
upstream for an explicit client API.

The panel host follows the [VS Code webview guide][webviews].  Paperproof
was read at `05c68e9cb8e881f9e971abb94efd231a269e0229` for its
[panel host][paperproof-host] and [version error][paperproof-version].
No upstream code is copied.

[#62]: https://github.com/formalverification/agda-native-ide/issues/62
[#64]: https://github.com/formalverification/agda-native-ide/issues/64
[#65]: https://github.com/formalverification/agda-native-ide/issues/65
[#66]: https://github.com/formalverification/agda-native-ide/issues/66
[#69]: https://github.com/formalverification/agda-native-ide/issues/69
[registration]: https://github.com/banacorn/agda-mode-vscode/blob/535b3eb8f09132edbad87017562e6cb7aab99a7c/src/Main/Main.res
[dispatch]: https://github.com/banacorn/agda-mode-vscode/blob/535b3eb8f09132edbad87017562e6cb7aab99a7c/src/State/State__Command.res
[responses]: https://github.com/banacorn/agda-mode-vscode/blob/535b3eb8f09132edbad87017562e6cb7aab99a7c/src/State/State__Response.res
[webviews]: https://code.visualstudio.com/api/extension-guides/webview
[paperproof-host]: https://github.com/Paper-Proof/paperproof/blob/05c68e9cb8e881f9e971abb94efd231a269e0229/extension/src/actions/toggleWebviewPanel/index.ts
[paperproof-version]: https://github.com/Paper-Proof/paperproof/blob/05c68e9cb8e881f9e971abb94efd231a269e0229/extension/src/services/getLeanClient.ts

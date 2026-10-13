// File: src/lib/codemirror/lsp-hover.ts
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/codemirror/lsp-hover.ts at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The language server counts a position's character
// in code points, where CodeMirror's client sends UTF-16 code units, the
// protocol's default: on a line with a character outside the Basic
// Multilingual Plane before the pointer (agda-algebras' 𝑆, 𝑨, 𝒦), the
// server read the token that many characters to the right.  The request's
// position, and the range of the answer, are now in code points
// (issue 10).

import type * as lsp from "vscode-languageserver-protocol"
import {EditorView, type Tooltip, hoverTooltip} from "@codemirror/view"
import type {Extension} from "@codemirror/state"
import {language as languageFacet, highlightingFor} from "@codemirror/language"
import {highlightCode} from "@lezer/highlight"

// import {fromPosition} from "./pos"

import {Text} from "@codemirror/state"

/// The offset of a server's position: its character counted in code
/// points from the line's start.
export function fromPosition(doc: Text, pos: lsp.Position): number {
  let line = doc.line(pos.line + 1)
  let offset = 0, count = 0
  for (const ch of line.text) {
    if (count == pos.character) break
    offset += ch.length
    count++
  }
  return line.from + offset
}

/// A position as the server counts it: its line, and its character in
/// code points from the line's start.
export function toPosition(doc: Text, pos: number): lsp.Position {
  let line = doc.lineAt(pos)
  return {line: line.number - 1, character: [...line.text.slice(0, pos - line.from)].length}
}

// import {escHTML} from "./text"

export function escHTML(text: string) {
  return text.replace(/[\n<&]/g, ch => ch == "\n" ? "<br>" : ch == "<" ? "&lt;" : "&amp;")
}

import { type LSPClientConfig, LSPPlugin, type LSPClient } from '@codemirror/lsp-client'

interface LSPClientPriv extends LSPClient {
  hasCapability: (cap: string) => boolean
  config: LSPClientConfig
}

interface LSPPluginPriv extends LSPPlugin {
  client: LSPClientPriv
}

/// Create an extension that queries the language server for hover
/// tooltips when the user hovers over the code with their pointer,
/// and displays a tooltip when the server provides one.
export function hoverTooltips(config?: Parameters<typeof hoverTooltip>[1]): Extension {
  return hoverTooltip(lspTooltipSource, config)
}

function hoverRequest(plugin: LSPPluginPriv, pos: number) {
  if (plugin.client.hasCapability("hoverProvider") === false) return Promise.resolve(null)
  plugin.client.sync()
  return plugin.client.request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
    position: toPosition(plugin.view.state.doc, pos),
    textDocument: {uri: plugin.uri},
  })
}

function lspTooltipSource(view: EditorView, pos: number, side: -1 | 1): Promise<Tooltip | null> {
  const plugin = LSPPlugin.get(view)
  if (!plugin) return Promise.resolve(null)

  // add a soft timeout to show a loading message before the info loads
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(resolve, 300)
  })

  // TODO: allow to skip the request if the cursor is not at an identifier

  const hoverPromise = hoverRequest(plugin as LSPPluginPriv, pos)

  return Promise.race([
    timeoutPromise.then(() => true),
    hoverPromise.then(() => false),
  ]).then<Tooltip | null>((timedOut) => {
    if (timedOut) {
      const dummyTooltip = {
        // XXX: these values are updated after the hover promise is resolved
        pos, end: pos,
        create() {
          let elt = document.createElement("div")
          elt.className = "cm-lsp-hover-tooltip cm-lsp-documentation cm-lsp-hover-tooltip--loading"
          elt.innerHTML = "Loading..."

          hoverPromise.then(result => {
            elt.classList.remove("cm-lsp-hover-tooltip--loading")
            if (result) {
              dummyTooltip.pos = result.range ? fromPosition(view.state.doc, result.range.start) : pos
              dummyTooltip.end = result.range ? fromPosition(view.state.doc, result.range.end) : pos

              elt.innerHTML = renderTooltipContent(plugin as LSPPluginPriv, result.contents)
            } else {
              // should remove?
              elt.innerHTML = ''
            }
          })

          return {dom: elt}
        },
      }

      return dummyTooltip
    } else {
      clearTimeout(timer)
      return hoverPromise.then(result => {
        if (!result) return null
        return {
          pos: result.range ? fromPosition(view.state.doc, result.range.start) : pos,
          end: result.range ? fromPosition(view.state.doc, result.range.end) : pos,
          create() {
            let elt = document.createElement("div")
            elt.className = "cm-lsp-hover-tooltip cm-lsp-documentation"
            elt.innerHTML = renderTooltipContent(plugin as LSPPluginPriv, result.contents)
            return {dom: elt}
          },
          // above: true
        }
      })
    }
  })
}

function renderTooltipContent(
  plugin: LSPPluginPriv,
  value: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[]
) {
  if (Array.isArray(value)) return value.map(m => renderCode(plugin, m)).join("<br>")
  if (typeof value == "string" || typeof value == "object" && "language" in value) return renderCode(plugin, value)
  return plugin.docToHTML(value)
}

function renderCode(plugin: LSPPluginPriv, code: lsp.MarkedString) {
  if (typeof code == "string") return plugin.docToHTML(code, "markdown")
  let {language, value} = code
  let lang = plugin.client.config.highlightLanguage && plugin.client.config.highlightLanguage(language || "")
  if (!lang) {
    let viewLang = plugin.view.state.facet(languageFacet)
    if (viewLang && (!language || viewLang.name == language)) lang = viewLang
  }
  if (!lang) return escHTML(value)
  let result = ""
  highlightCode(value, lang.parser.parse(value), {style: tags => highlightingFor(plugin.view.state, tags)}, (text, cls) => {
    result += cls ? `<span class="${cls}">${escHTML(text)}</span>` : escHTML(text)
  }, () => {
    result += "<br>"
  })
  return result
}

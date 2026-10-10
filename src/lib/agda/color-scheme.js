// File: src/lib/agda/color-scheme.js
//
// Changed from SeungheonOh/plfa-playground's src/lib/agda/color-scheme.js at
// ae0aa84c24363a8d6dadc292b6eb8f88f7f38705 (docs/provenance.md).
// Colors use the shared tokens in static/theme.css (issue 17).

import { EditorView } from '@codemirror/view'

const scheme = {
  // not a part of Agda's theme, but Emacs' built-in palette
  '.agda-hole': { background: 'var(--agda-hole-surface)' },
  // make error markers opaque
  '.agda-error *': { color: 'currentColor !important' },

  // extracted from Agda's Emacs theme
  // definitions are from `Agda/Syntax/Common/Aspect.hs`
  // strings are from `toAtoms :: Aspects -> [String]`

  // -- aspects
  '.agda-comment':                  { color: 'var(--agda-comment)', fontStyle: 'italic' },
  '.agda-keyword':                  { color: 'var(--agda-keyword)' },
  '.agda-string':                   { color: 'var(--agda-string)' },
  '.agda-number':                   { color: 'var(--agda-number)' },
  //   hole; see above
  '.agda-symbol':                   { color: 'var(--agda-symbol)' },
  '.agda-primitivetype':            { color: 'var(--agda-primitivetype)' },
  //   -- name kinds
  //     bound
  //     generalizable
    '.agda-inductiveconstructor':   { color: 'var(--agda-inductiveconstructor)' },
    '.agda-coinductiveconstructor': { color: 'var(--agda-coinductiveconstructor)' },
    '.agda-datatype':               { color: 'var(--agda-datatype)' },
    '.agda-field':                  { color: 'var(--agda-field)' },
    '.agda-function':               { color: 'var(--agda-function)' },
    '.agda-module':                 { color: 'var(--agda-module)' },
    '.agda-postulate':              { color: 'var(--agda-postulate)' },
    '.agda-primitive':              { color: 'var(--agda-primitive)' },
    '.agda-record':                 { color: 'var(--agda-record)' },
  //     argument
    '.agda-macro':                  { color: 'var(--agda-macro)' },
  //   -- end of name kinds
  //   pragma, background, markup

  // -- "other" aspects
  '.agda-error':                    { color: 'var(--agda-error)' },
  '.agda-errorwarning':             { backgroundColor: 'var(--agda-errorwarning-surface)' },
  // dottedpattern
  '.agda-unsolvedmeta':             { backgroundColor: 'var(--agda-unsolvedmeta-surface)' },
  '.agda-unsolvedconstraint':       { backgroundColor: 'var(--agda-unsolvedconstraint-surface)' },
  '.agda-terminationproblem':       { backgroundColor: 'var(--agda-terminationproblem-surface)' },
  '.agda-positivityproblem':        { backgroundColor: 'var(--agda-positivityproblem-surface)' },
  '.agda-deadcode':                 { backgroundColor: 'var(--agda-deadcode-surface)' },
  '.agda-shadowingintelescope':     { backgroundColor: 'var(--agda-shadowingintelescope-surface)' },
  '.agda-coverageproblem':          { backgroundColor: 'var(--agda-coverageproblem-surface)' },
  // incompletepattern
  '.agda-typechecks':               { color: 'var(--agda-typechecks)', backgroundColor: 'var(--agda-typechecks-surface)' },
  '.agda-missingdefinition':        { backgroundColor: 'var(--agda-missingdefinition-surface)' },
  '.agda-instanceproblem':          { backgroundColor: 'var(--agda-instanceproblem-surface)' },
  '.agda-cosmeticproblem':          { backgroundColor: 'var(--agda-cosmeticproblem-surface)' },
  '.agda-catchallclause':           { backgroundColor: 'var(--agda-catchallclause-surface)' },
  '.agda-confluenceproblem':        { backgroundColor: 'var(--agda-confluenceproblem-surface)' },
}

export const agdaLightSchemeFromEmacs = EditorView.theme(scheme)
export const agdaDarkSchemeFromEmacs = EditorView.theme(scheme, { dark: true })

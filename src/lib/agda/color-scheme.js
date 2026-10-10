// File: src/lib/agda/color-scheme.js
//
// Changed from SeungheonOh/plfa-playground's src/lib/agda/color-scheme.js at
// ae0aa84c24363a8d6dadc292b6eb8f88f7f38705 (docs/provenance.md).
// Colors use the shared tokens in src/app.css (issue 17).

import { EditorView } from '@codemirror/view'

export const agdaLightSchemeFromEmacs = EditorView.theme({
  // not a part of Agda's theme, but Emacs' built-in palette
  '.agda-hole': { background: 'var(--agda-hole-surface-light)' },  // darkseagreen2
  // make error markers opaque
  '.agda-error *': { color: 'currentColor !important' },

  // extracted from Agda's Emacs theme
  // definitions are from `Agda/Syntax/Common/Aspect.hs`
  // strings are from `toAtoms :: Aspects -> [String]`

  // -- aspects
  '.agda-comment':                  { color: 'var(--agda-comment-light)', fontStyle: 'italic' },
  '.agda-keyword':                  { color: 'var(--agda-keyword-light)' },  // DarkOrange3
  '.agda-string':                   { color: 'var(--agda-string-light)' },  // firebrick
  '.agda-number':                   { color: 'var(--agda-number-light)' },  // purple
  //   hole; see above
  '.agda-symbol':                   { color: 'var(--agda-symbol-light)' },  // gray25
  '.agda-primitivetype':            { color: 'var(--agda-primitivetype-light)' },  // medium blue
  //   -- name kinds
  //     bound
  //     generalizable
    '.agda-inductiveconstructor':   { color: 'var(--agda-inductiveconstructor-light)' },  // green4
    '.agda-coinductiveconstructor': { color: 'var(--agda-coinductiveconstructor-light)' },  // gold4
    '.agda-datatype':               { color: 'var(--agda-datatype-light)' },  // medium blue
    '.agda-field':                  { color: 'var(--agda-field-light)' },  // DeepPink2
    '.agda-function':               { color: 'var(--agda-function-light)' },  // medium blue
    '.agda-module':                 { color: 'var(--agda-module-light)' },  // purple
    '.agda-postulate':              { color: 'var(--agda-postulate-light)' },  // medium blue
    '.agda-primitive':              { color: 'var(--agda-primitive-light)' },  // medium blue
    '.agda-record':                 { color: 'var(--agda-record-light)' },  // medium blue
  //     argument
    '.agda-macro':                  { color: 'var(--agda-macro-light)' },  // aquamarine4
  //   -- end of name kinds
  //   pragma, background, markup

  // -- "other" aspects
  '.agda-error':                    { color: 'var(--agda-error-light)' },
  '.agda-errorwarning':             { backgroundColor: 'var(--agda-errorwarning-surface-light)' },  // light coral
  // dottedpattern
  '.agda-unsolvedmeta':             { backgroundColor: 'var(--agda-unsolvedmeta-surface-light)' },  // yellow
  '.agda-unsolvedconstraint':       { backgroundColor: 'var(--agda-unsolvedconstraint-surface-light)' },  // yellow
  '.agda-terminationproblem':       { backgroundColor: 'var(--agda-terminationproblem-surface-light)' },  // light salmon
  '.agda-positivityproblem':        { backgroundColor: 'var(--agda-positivityproblem-surface-light)' },  // peru
  '.agda-deadcode':                 { backgroundColor: 'var(--agda-deadcode-surface-light)' },  // dark gray
  '.agda-shadowingintelescope':     { backgroundColor: 'var(--agda-shadowingintelescope-surface-light)' },  // dark gray
  '.agda-coverageproblem':          { backgroundColor: 'var(--agda-coverageproblem-surface-light)' },  // wheat
  // incompletepattern
  '.agda-typechecks':               { color: 'var(--agda-typechecks-light)', backgroundColor: 'var(--agda-typechecks-surface-light)' },  // light blue
  '.agda-missingdefinition':        { backgroundColor: 'var(--agda-missingdefinition-surface-light)' },  // orange
  '.agda-instanceproblem':          { backgroundColor: 'var(--agda-instanceproblem-surface-light)' },  // wheat
  '.agda-cosmeticproblem':          { backgroundColor: 'var(--agda-cosmeticproblem-surface-light)' },  // white smoke
  '.agda-catchallclause':           { backgroundColor: 'var(--agda-catchallclause-surface-light)' },  // white smoke
  '.agda-confluenceproblem':        { backgroundColor: 'var(--agda-confluenceproblem-surface-light)' },  // pink
})

export const agdaDarkSchemeFromEmacs = EditorView.theme({
  // not a part of Agda's theme, but Emacs' built-in palette
  '.agda-hole': { background: 'var(--agda-hole-surface-dark)' },  // DarkOliveGreen
  // make error markers opaque
  '.agda-error *': { color: 'currentColor !important' },

  // extracted from Agda's Emacs theme
  // definitions are from `Agda/Syntax/Common/Aspect.hs`
  // strings are from `toAtoms :: Aspects -> [String]`

  // -- aspects
  '.agda-comment':                  { color: 'var(--agda-comment-dark)', fontStyle: 'italic' },
  '.agda-keyword':                  { color: 'var(--agda-keyword-dark)' },
  '.agda-string':                   { color: 'var(--agda-string-dark)' },
  '.agda-number':                   { color: 'var(--agda-number-dark)' },
  //   hole; see above
  '.agda-symbol':                   { color: 'var(--agda-symbol-dark)' },  // gray75
  '.agda-primitivetype':            { color: 'var(--agda-primitivetype-dark)' },
  //   -- name kinds
  //     bound
  //     generalizable
    '.agda-inductiveconstructor':   { color: 'var(--agda-inductiveconstructor-dark)' },
    '.agda-coinductiveconstructor': { color: 'var(--agda-coinductiveconstructor-dark)' },
    '.agda-datatype':               { color: 'var(--agda-datatype-dark)' },
    '.agda-field':                  { color: 'var(--agda-field-dark)' },
    '.agda-function':               { color: 'var(--agda-function-dark)' },
    '.agda-module':                 { color: 'var(--agda-module-dark)' },
    '.agda-postulate':              { color: 'var(--agda-postulate-dark)' },
    '.agda-primitive':              { color: 'var(--agda-primitive-dark)' },
    '.agda-record':                 { color: 'var(--agda-record-dark)' },
  //     argument
    '.agda-macro':                  { color: 'var(--agda-macro-dark)' },
  //   -- end of name kinds
  //   pragma, background, markup

  // -- "other" aspects
  '.agda-error':                    { color: 'var(--agda-error-dark)' },
  '.agda-errorwarning':             { backgroundColor: 'var(--agda-errorwarning-surface-dark)' },
  // dottedpattern
  '.agda-unsolvedmeta':             { backgroundColor: 'var(--agda-unsolvedmeta-surface-dark)' },
  '.agda-unsolvedconstraint':       { backgroundColor: 'var(--agda-unsolvedconstraint-surface-dark)' },
  '.agda-terminationproblem':       { backgroundColor: 'var(--agda-terminationproblem-surface-dark)' },
  '.agda-positivityproblem':        { backgroundColor: 'var(--agda-positivityproblem-surface-dark)' },
  '.agda-deadcode':                 { backgroundColor: 'var(--agda-deadcode-surface-dark)' },
  '.agda-shadowingintelescope':     { backgroundColor: 'var(--agda-shadowingintelescope-surface-dark)' },
  '.agda-coverageproblem':          { backgroundColor: 'var(--agda-coverageproblem-surface-dark)' },
  // incompletepattern
  '.agda-typechecks':               { color: 'var(--agda-typechecks-dark)', backgroundColor: 'var(--agda-typechecks-surface-dark)' },
  '.agda-missingdefinition':        { backgroundColor: 'var(--agda-missingdefinition-surface-dark)' },
  '.agda-instanceproblem':          { backgroundColor: 'var(--agda-instanceproblem-surface-dark)' },
  '.agda-cosmeticproblem':          { backgroundColor: 'var(--agda-cosmeticproblem-surface-dark)' },
  '.agda-catchallclause':           { backgroundColor: 'var(--agda-catchallclause-surface-dark)' },
  '.agda-confluenceproblem':        { backgroundColor: 'var(--agda-confluenceproblem-surface-dark)' },
}, { dark: true })

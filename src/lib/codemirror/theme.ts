// File: src/lib/codemirror/theme.ts
//
// Changed from SeungheonOh/plfa-playground's src/lib/codemirror/theme.ts at
// ae0aa84c24363a8d6dadc292b6eb8f88f7f38705 (docs/provenance.md).
// Colors use the shared tokens in static/theme.css.  The dark facet
// follows the page's saved choice and system preference (issue 17).

import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { prefersDarkTheme } from '$lib/theme'

// TODO: split baseTheme with (the real) theme
export const myBaseTheme = EditorView.baseTheme({
  '&': {
    border: '0 none',
    fontSize: '14px',
    '&.cm-focused': {
      outline: '0 none',
      // outlineOffset: '1px',
    },
  },
  '&.cm-editor': {
    borderRadius: '0',
    height: '100%',
    width: '100%',
  },
  '.cm-content, .cm-lineNumbers, .cm-gutterElement': {
    fontFamily: 'JuliaMono, monospace',
    // seems that more people love half-width arrows...
    // fontFeatureSettings: '"calt" off, "NWID" on',
  },
  '&dark .cm-activeLine': {
    backgroundColor: 'var(--editor-dark-active-line)',
  },
  '&dark .cm-activeLineGutter': {
    background: 'var(--editor-dark-active-line)',
  },
  '.cm-selectionMatch.cm-selectionMatch': {
    // FIXME
    backgroundColor: 'transparent',
    outline: '1px solid var(--editor-selection-match-line)',
    borderRadius: '2px',
  },
  '&dark .cm-selectionMatch.cm-selectionMatch': {
    outlineColor: 'var(--editor-dark-selection-match-line)',
  },

  '&dark .cm-cursor': {
    borderLeftColor: 'var(--editor-dark-cursor)',
    borderLeftWidth: '2px',
  },
  '&dark .cm-foldPlaceholder.cm-foldPlaceholder': {
    // FIXME
    backgroundColor: 'var(--editor-fold-surface)',
    borderColor: 'var(--editor-fold-line)',
  },

  '.cm-tooltip-section': {
    padding: '4px',
    marginTop: '4px',
    marginBottom: '0',
  },
  '&dark .cm-tooltip-section': {
    borderTop: '1px solid var(--editor-tooltip-section-line)',
  },

  '&dark .cm-tooltip.cm-tooltip.cm-tooltip-hover': {
    borderColor: 'var(--editor-tooltip-hover-line)',
  },

  '.cm-tooltip-section:first-child': {
    marginTop: '0',
    borderTop: 'none',
  },

  '.cm-tooltip.cm-tooltip-above': {
    marginBottom: '7px',
  },

  // helpers
  '.cm-agda-marks.hovered-keyword': {
    borderRadius: '2px',
    outline: '1px solid var(--editor-hover-line)',
  },
  '&dark .cm-agda-marks.hovered-keyword': {
    outlineColor: 'var(--editor-dark-hover-line)',
  },
})

const SELECTOR_PREFERS_DARK_COLOR_SCHEME = '(prefers-color-scheme: dark)'

export function autoColorScheme(options: {
  dark?: Extension, light?: Extension, defaultDark?: boolean} = {}): Extension {

  const {
    dark: darkExt = [],
    light: lightExt = [],
    defaultDark = typeof document !== 'undefined' &&
      prefersDarkTheme(document.documentElement, window),
  } = options

  const darkThemeCompartment = new Compartment()

  function darkThemeExt(dark: boolean): Extension {
    return dark ? darkExt : lightExt
  }

  const plugin = ViewPlugin.define((view) => {
    const doc = view.dom.ownerDocument
    const win = doc.defaultView
    if (!win) return {}
    let currentDark = defaultDark
    let alive = true
    function synchronize() {
      if (!alive) return
      const dark = prefersDarkTheme(doc.documentElement, win!)
      if (dark === currentDark) return
      currentDark = dark
      view.dispatch({
        effects: darkThemeCompartment.reconfigure(darkThemeExt(dark)),
      })
    }
    const query = win.matchMedia(SELECTOR_PREFERS_DARK_COLOR_SCHEME)
    query.addEventListener('change', synchronize)
    const observer = new MutationObserver(synchronize)
    observer.observe(doc.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    })
    // A different owner document can disagree with the factory's window.
    // Reconfigure after EditorView has finished constructing its plugins.
    queueMicrotask(synchronize)
    return {
      destroy() {
        alive = false
        observer.disconnect()
        query.removeEventListener('change', synchronize)
      }
    }
  })

  return [
    plugin,
    darkThemeCompartment.of(darkThemeExt(defaultDark)),
  ]
}

export function myCodeMirrorTheme(): Extension {
  return [
    myBaseTheme,
    // The fallback syntax spans can nest inside Agda's semantic marks.
    // Inherit their foreground so a light-only fallback cannot hide the
    // surrounding Agda color.  Unchecked text uses the editor text token.
    syntaxHighlighting(HighlightStyle.define(defaultHighlightStyle.specs.map(
      (spec) => spec.color ? { ...spec, color: 'inherit' } : spec,
    ))),
    EditorView.theme({
      '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        backgroundColor: 'var(--selection-surface)',
      },
      '.cm-foldPlaceholder': {
        color: 'var(--muted)',
        backgroundColor: 'var(--surface-soft)',
        borderColor: 'var(--line)',
      },
      '.cm-searchMatch, .cm-searchMatch-selected': {
        backgroundColor: 'var(--selection-surface)',
        outline: '1px solid var(--accent)',
      },
      '.cm-matchingBracket': {
        backgroundColor: 'var(--selection-surface)',
      },
      '.cm-nonmatchingBracket': {
        backgroundColor: 'var(--error-soft)',
      },
      '.cm-panels': {
        color: 'var(--text)', backgroundColor: 'var(--surface)',
      },
      '.cm-tooltip': {
        color: 'var(--text)',
        backgroundColor: 'var(--surface)',
        overflow: 'auto',
        zIndex: 500,  // must be > 300 (.cm-panels)
      },
      '.cm-tooltip.cm-tooltip-hover': {
        borderRadius: '2px',
        border: '1px solid var(--editor-tooltip-line)',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        color: 'var(--symbol-selected-text)',
        backgroundColor: 'var(--symbol-selected-surface)',
      },
    }),
  ]
}

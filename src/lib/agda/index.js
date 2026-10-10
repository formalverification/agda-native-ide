// File: src/lib/agda/index.js
// Changed from SeungheonOh/plfa-playground's src/lib/agda/index.js at
// ae0aa84c24363a8d6dadc292b6eb8f88f7f38705 (docs/provenance.md).
// Initialize the editor from the page's theme choice (issue 17).

import { autoColorScheme } from '$lib/codemirror/theme'
import { offsetTracking } from '$lib/codemirror/offsets'

import { agdaHighlight } from './highlight'
import { agdaDarkSchemeFromEmacs, agdaLightSchemeFromEmacs } from './color-scheme'
import { agdaGoals } from './goals'

/**
 * @typedef _AgdaSupportOptions
 * @prop {void} _
 */

/** @typedef {Partial<_AgdaSupportOptions>} AgdaSupportOptions */

/**
 * @param {AgdaSupportOptions} [options]
 * @returns {import('@codemirror/state').Extension}
 */
export function agdaSupport(options) {
  void options
  return [
    offsetTracking(),
    autoColorScheme({
      dark: agdaDarkSchemeFromEmacs,
      light: agdaLightSchemeFromEmacs,
    }),
    agdaHighlight(),
    agdaGoals(),
  ]
}

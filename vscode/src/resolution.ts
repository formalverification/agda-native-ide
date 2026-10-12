// File: vscode/src/resolution.ts
//
// Which Agda the native lanes run, from the settings (issue 64), in the
// following order:
//
//   1.  agdaWorkbench.agda.path, with agdaWorkbench.agda.commandLineOptions,
//       when it is set (and then nothing else is tried);
//   2.  agda-mode-vscode's agdaMode.connection.paths, from the last entry
//       to the first, as the mode tries them, passing over a URL or a
//       language server (an `als`), with agdaMode.connection.commandLineOptions;
//   3.  `agda` on PATH, with the mode's options.
//
// So without a setting of its own the companion runs the mode's Agda with
// the mode's options, and the two read and write the same `_build/`
// interfaces.  The engine's resolveAgda takes the first that names an
// executable and checks its version.  This module imports nothing of
// VS Code's, so its tests run under node.

import { basename } from 'node:path';
import type { AgdaCandidate } from '@agda-native-ide/engine/native';

/** A setting's options, split as agda-mode-vscode 0.10.4 splits its
 * commandLineOptions: on single spaces, blank words dropped. */
export function splitOptions(value: unknown): string[] {
  return typeof value === 'string' ? value.trim().split(' ').filter(word => word.trim() !== '') : [];
}

/** A language server, which speaks LSP and not --interaction-json: a URL,
 * or an executable named for the Agda Language Server. */
export function isLanguageServer(entry: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ||
    /^(als|agda-language-server)([-_.][\w.-]*)?(\.exe)?$/i.test(basename(entry));
}

export interface AgdaSettings {
  workbenchPath?: unknown;
  workbenchOptions?: unknown;
  modePaths?: unknown;
  modeOptions?: unknown;
}

export function agdaCandidates(settings: AgdaSettings): AgdaCandidate[] {
  const own = typeof settings.workbenchPath === 'string' ? settings.workbenchPath.trim() : '';
  if (own) return [{
    source: 'agdaWorkbench.agda.path', executable: own,
    args: splitOptions(settings.workbenchOptions), argsSource: 'agdaWorkbench.agda.commandLineOptions',
  }];
  const args = splitOptions(settings.modeOptions);
  const argsSource = 'agdaMode.connection.commandLineOptions';
  const paths = Array.isArray(settings.modePaths)
    ? settings.modePaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
  return [
    ...paths.reverse().filter(entry => !isLanguageServer(entry.trim()))
      .map(entry => ({ source: 'agdaMode.connection.paths', executable: entry.trim(), args, argsSource })),
    { source: 'PATH', executable: 'agda', args, argsSource },
  ];
}

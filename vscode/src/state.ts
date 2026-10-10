// File: vscode/src/state.ts

export const actions = ['load', 'give', 'refine', 'goalContext', 'highlighting'] as const;
export type Action = typeof actions[number];

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && actions.some(action => action === value);
}

export interface CommandReport {
  action: Action;
  elapsedMs: number;
  documentChanged: boolean;
  tokenCount?: number;
}

export interface PanelState {
  schema: 1;
  uri: string | null;
  lastCommand: CommandReport | null;
}

export function restoreState(value: unknown): PanelState {
  const empty: PanelState = { schema: 1, uri: null, lastCommand: null };
  if (!value || typeof value !== 'object') return empty;
  const state = value as Record<string, unknown>;
  if (state.schema !== 1) return empty;
  const uri = typeof state.uri === 'string' && state.uri.length <= 8192 ? state.uri : null;
  let lastCommand: CommandReport | null = null;
  if (state.lastCommand && typeof state.lastCommand === 'object') {
    const report = state.lastCommand as Record<string, unknown>;
    if (isAction(report.action) && typeof report.elapsedMs === 'number' &&
        Number.isFinite(report.elapsedMs) && report.elapsedMs >= 0 &&
        typeof report.documentChanged === 'boolean') {
      lastCommand = {
        action: report.action, elapsedMs: report.elapsedMs,
        documentChanged: report.documentChanged,
      };
      if (typeof report.tokenCount === 'number' && Number.isSafeInteger(report.tokenCount) &&
          report.tokenCount >= 0) lastCommand.tokenCount = report.tokenCount;
    }
  }
  return { schema: 1, uri, lastCommand };
}

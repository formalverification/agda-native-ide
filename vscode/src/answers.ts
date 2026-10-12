// File: vscode/src/answers.ts
//
// The panel's account of what a native lane answered, in plain text.  It
// imports nothing of VS Code's, so its tests run under node.

import type { ToolResult } from '@agda-native-ide/tools';

/** A give through the interaction lane, as the panel reports it. */
export type GiveResult =
  | {
      tool: 'give'; status: 'answer'; lane: 'interaction'; elapsedMs: number;
      result: { goal: number; term: string; accepted: boolean; error?: string; applied: boolean };
    }
  | { tool: 'give'; status: 'refused' | 'failed'; reason: string; message: string };

const isGive = (result: ToolResult | GiveResult): result is GiveResult => result.tool === 'give';

/** The panel's account of a lane's answer, in plain text. */
export function describeResult(result: ToolResult | GiveResult): string {
  if (isGive(result)) {
    if (result.status !== 'answer') return result.message;
    const give = result.result;
    if (!give.accepted) return `Agda refused ${give.term} for goal ${give.goal}: ${give.error ?? 'no reason given'}`;
    return `Agda took ${give.term} for goal ${give.goal}.${give.applied ? '' : '  The module changed meanwhile, so the edit was not applied.'}`;
  }
  if (result.status === 'refused' || result.status === 'failed') return result.message;
  if (result.status === 'verdict') {
    const verdict = result.result as { success: boolean; diagnostics: Array<{ code?: string; range?: { startLine: number; startCol: number }; message: string }> };
    const first = verdict.diagnostics.find(diagnostic => diagnostic.code) ?? verdict.diagnostics[0];
    const where = first?.range ? ` at line ${first.range.startLine}, column ${first.range.startCol}` : '';
    return `Batch verdict: exit ${result.verdict.exitCode}, ${verdict.success ? 'the module checks' : 'the module does not check'}.` +
      (first ? `\n${first.code ?? 'Agda'}${where}:\n${first.message}` : '');
  }
  if (result.status !== 'answer') return '';
  const value = result.result as Record<string, unknown>;
  if (result.tool === 'get_goal') {
    const context = (value.context as Array<{ name: string; type: string; inScope: boolean }>)
      .map(entry => `  ${entry.name} : ${entry.type}${entry.inScope ? '' : '  (not in scope)'}`);
    return [`Goal ${String(value.goal)}: ${String(value.type)}`, ...(context.length ? ['', 'Context:', ...context] : [])].join('\n');
  }
  if (typeof value.error === 'string') return value.error;
  return result.tool === 'type_of' ? `Type: ${String(value.type)}` : `Normal form: ${String(value.normalForm)}`;
}

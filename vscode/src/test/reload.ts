// File: vscode/src/test/reload.ts
// A test-only development extension.  VS Code's test host cannot reload;
// a normal development window can, with this driver activated each time.

import * as assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Companion } from '../extension';
import { PanelState } from '../state';

async function until(predicate: () => boolean): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 20000) throw new Error('The serialized webview was not restored.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function reload(): Promise<void> {
  const output = process.env.COMPANION_TEST_OUTPUT!;
  const marker = path.join(output, 'reload-state.json');
  let saved: { state: PanelState; viewColumn: vscode.ViewColumn | undefined } | undefined;
  try { saved = JSON.parse(await readFile(marker, 'utf8')); } catch { /* First window. */ }
  const api = await vscode.extensions.getExtension<{ companion: Companion }>('formalverification.agda-native-ide')!.activate();
  const companion = api.companion;
  if (!saved) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'Overture/Basic.agda'));
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('agdaWorkbench.open');
    await vscode.commands.executeCommand('agdaWorkbench.load');
    await until(() => companion.getPersistedState()?.lastCommand?.action === 'load');
    await writeFile(marker, JSON.stringify({ state: companion.getState(), viewColumn: companion.getPanel()?.viewColumn }));
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else {
    await until(() => companion.getPanel() !== undefined && companion.getPersistedState() !== undefined);
    assert.deepEqual(companion.getState(), saved.state);
    assert.equal(companion.getPanel()?.viewColumn, saved.viewColumn);
    assert.ok(companion.getSnapshot()?.text.includes('module Overture.Basic where'));
    await writeFile(path.join(output, 'reload-result.json'), JSON.stringify({ restored: true, state: saved }) + '\n');
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

export function activate(): void {
  void reload().catch(async error => {
    await writeFile(path.join(process.env.COMPANION_TEST_OUTPUT!, 'reload-result.json'), JSON.stringify({ restored: false, error: String(error) }) + '\n');
    await vscode.commands.executeCommand('workbench.action.quit');
  });
}

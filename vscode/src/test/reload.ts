// File: vscode/src/test/reload.ts
// A test-only development extension.  VS Code's test host cannot reload;
// a normal development window can, with this driver activated each time.

import * as assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Companion } from '../extension';
import type { PanelState } from '../state';

async function until(predicate: () => boolean | Thenable<boolean>, label: string): Promise<void> {
  const started = performance.now();
  while (!(await predicate())) {
    if (performance.now() - started > 20000) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function reload(): Promise<void> {
  const output = process.env.COMPANION_TEST_OUTPUT!;
  const testCase = process.env.COMPANION_RELOAD_CASE ?? 'visible';
  const marker = path.join(output, `reload-state-${testCase}.json`);
  let saved: {
    stage: 'visible' | 'hidden'; state: PanelState;
    viewColumn: vscode.ViewColumn | undefined; coverUri?: string;
  } | undefined;
  try { saved = JSON.parse(await readFile(marker, 'utf8')); } catch { /* First window. */ }
  const api = await vscode.extensions.getExtension<{ companion: Companion }>('formalverification.agda-native-ide')!.activate();
  const companion = api.companion;
  if (!saved) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'Overture/Basic.agda'));
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('agdaWorkbench.open');
    await vscode.commands.executeCommand('agdaWorkbench.load');
    await until(() => companion.getPersistedState()?.lastCommand?.action === 'load', 'saved load state');
    const panel = companion.getPanel()!;
    const viewColumn = panel.viewColumn;
    let coverUri: vscode.Uri | undefined;
    if (testCase === 'hidden') {
      const root = vscode.workspace.workspaceFolders![0]!.uri;
      coverUri = vscode.Uri.joinPath(root, 'Cover.txt');
      await vscode.workspace.fs.writeFile(coverUri, Buffer.from('Cover the workbench'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(coverUri), {
        viewColumn, preview: false,
      });
      await until(() => !panel.visible, 'panel hidden');
      await until(async () => !(await panel.webview.postMessage({ type: 'visibilityProbe' })), 'hidden webview disposed');
      const nextUri = vscode.Uri.joinPath(root, 'HiddenTarget.agda');
      await vscode.workspace.fs.writeFile(nextUri, Buffer.from('module HiddenTarget where\n'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(nextUri), {
        viewColumn, preserveFocus: false, preview: false,
      });
      await until(() => companion.getState().uri === nextUri.toString(), 'host module changed while hidden');
      assert.equal(companion.getPersistedState()?.uri, document.uri.toString(), 'the hidden webview still has the old state');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(coverUri), {
        viewColumn, preserveFocus: false, preview: false,
      });
      const nextTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === nextUri.toString());
      assert.ok(nextTab);
      await vscode.window.tabGroups.close(nextTab, true);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(nextUri), {
        viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false,
      });
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), coverUri.toString());
    }
    await writeFile(marker, JSON.stringify({ stage: testCase, state: companion.getState(), viewColumn, coverUri: coverUri?.toString() }));
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else {
    if (saved.stage === 'hidden') {
      const cover = await vscode.workspace.openTextDocument(vscode.Uri.parse(saved.coverUri!));
      await vscode.window.showTextDocument(cover, { viewColumn: saved.viewColumn });
      // Select the existing saved webview tab; do not create a new panel.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await until(() => companion.getPanel() !== undefined && companion.getPersistedState() !== undefined, `${saved.stage} panel restoration`);
    assert.deepEqual(companion.getState(), saved.state);
    assert.equal(companion.getPanel()?.viewColumn, saved.viewColumn);
    assert.ok(companion.getSnapshot()?.text.includes(saved.stage === 'hidden' ? 'module HiddenTarget where' : 'module Overture.Basic where'));
    await writeFile(path.join(output, `reload-result-${testCase}.json`), JSON.stringify({ restored: true, state: saved }) + '\n');
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}

export function activate(): void {
  void reload().catch(async error => {
    const testCase = process.env.COMPANION_RELOAD_CASE ?? 'visible';
    await writeFile(path.join(process.env.COMPANION_TEST_OUTPUT!, `reload-result-${testCase}.json`), JSON.stringify({ restored: false, error: String(error) }) + '\n');
    await vscode.commands.executeCommand('workbench.action.quit');
  });
}

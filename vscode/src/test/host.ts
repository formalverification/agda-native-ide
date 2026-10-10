// File: vscode/src/test/host.ts

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { Companion, DocumentSnapshot } from '../extension';

function deadline<T>(promise: Thenable<T>, label: string, ms = 45000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  await deadline((async () => {
    while (!predicate()) await new Promise(resolve => setTimeout(resolve, 50));
  })(), label, 15000);
}

export async function run(): Promise<void> {
  const output = process.env.COMPANION_TEST_OUTPUT!;
  const phase = process.env.COMPANION_TEST_CASE ?? 'supported';
  const extension = vscode.extensions.getExtension<{ companion: Companion; activationMs: number }>('formalverification.agda-native-ide');
  assert.ok(extension);
  const start = performance.now();
  const api = await extension.activate();
  const activationCallMs = performance.now() - start;
  const companion = api.companion;
  const windowIds = execFileSync('xdotool', ['search', '--onlyvisible', '--name', 'Extension Development Host'], { encoding: 'utf8' }).trim();
  assert.ok(windowIds, 'a visible extension development window must exist');
  const titles = windowIds.split('\n').map(id => execFileSync('xdotool', ['getwindowname', id], { encoding: 'utf8' }).trim());

  const root = vscode.workspace.workspaceFolders![0]!.uri;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'Overture', 'Basic.agda'));
  let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  if (phase === 'mismatch') {
    await until(() => companion.getPanel() !== undefined, 'version warning opens when an Agda editor appears after activation');
  }
  await deadline(vscode.commands.executeCommand('agdaWorkbench.open'), 'open panel');
  await until(() => companion.getPersistedState()?.uri === document.uri.toString(), 'webview loaded local assets and persisted state');
  const panel = companion.getPanel()!;
  assert.equal(panel.viewColumn, vscode.ViewColumn.Two);
  assert.equal(vscode.window.activeTextEditor?.document, document, 'opening preserves editor focus');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
  assert.ok(panel.webview.options.localResourceRoots?.every(uri => uri.path.endsWith('/media')));
  await vscode.commands.executeCommand('agdaWorkbench.open');
  assert.equal(companion.getPanel(), panel, 'open reuses the panel');

  const modeVersion = vscode.extensions.getExtension('banacorn.agda-mode')!.packageJSON.version;
  const status = companion.getCompatibility();
  assert.equal(status.installed, modeVersion);
  assert.equal(status.supported, phase === 'supported');
  if (phase === 'mismatch') assert.match(status.message, /999\.0\.0.*Tested versions: 0\.10\.4/);

  const runCommand = async (action: string) => {
    const snapshot = await deadline(vscode.commands.executeCommand<DocumentSnapshot>(`agdaWorkbench.${action}`), action);
    assert.equal(snapshot.text, document.getText());
    assert.equal(snapshot.version, document.version);
    return companion.getState().lastCommand!;
  };
  await assert.rejects(runCommand('highlighting'), /Load the module in Agda mode/);
  const load = await runCommand('load');
  assert.equal(document.isDirty, false, 'mode load saves the document');
  const position = document.positionAt(document.getText().indexOf('suc 0ℓ', document.getText().indexOf('ℓ₁ =')) + 1);
  editor.selection = new vscode.Selection(position, position);
  const context = await runCommand('goalContext');
  assert.equal(context.documentChanged, false);
  const highlighting = await runCommand('highlighting');
  assert.ok(highlighting.tokenCount! > 0, 'real mode semantic tokens');
  const beforeVersion = document.version;
  // Focus the webview before giving; the companion must restore the source editor.
  panel.reveal(vscode.ViewColumn.Two, false);
  await until(() => vscode.window.activeTextEditor === undefined, 'panel focus');
  const give = await runCommand('give');
  assert.equal(give.documentChanged, true, 'the real mode must edit the buffer');
  assert.ok(document.version > beforeVersion);
  assert.ok(document.getText().includes('ℓ₁ = suc 0ℓ'));
  assert.ok(!document.getText().includes('ℓ₁ = {!'));
  assert.equal(vscode.window.activeTextEditor?.document, document);

  editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  const replaceAt = document.getText().indexOf('suc 0ℓ', document.getText().indexOf('ℓ₁ ='));
  await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(replaceAt), document.positionAt(replaceAt + 'suc 0ℓ'.length)), '{! suc !}'));
  await runCommand('load');
  const refineAt = document.positionAt(document.getText().indexOf('suc', document.getText().indexOf('ℓ₁ =')) + 1);
  editor.selection = new vscode.Selection(refineAt, refineAt);
  const refine = await runCommand('refine');
  assert.equal(refine.documentChanged, true);
  assert.match(document.getText(), /ℓ₁ = suc \{!/);

  // An invalid candidate is reported by the mode, not inferred from command resolution.
  const holeAt = document.getText().indexOf('{!', document.getText().indexOf('ℓ₁ ='));
  const holeEnd = document.getText().indexOf('!}', holeAt) + 2;
  await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(holeAt), document.positionAt(holeEnd)), '{! nonexistentWorkbenchTerm !}'));
  const invalidAt = document.positionAt(holeAt + 4);
  editor.selection = new vscode.Selection(invalidAt, invalidAt);
  const invalid = await runCommand('give');
  assert.equal(invalid.documentChanged, false);
  assert.ok(document.getText().includes('nonexistentWorkbenchTerm'));
  await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(holeAt), document.positionAt(holeAt + '{! nonexistentWorkbenchTerm !}'.length)), '{!   !}'));
  await document.save();

  // A normal file must never send a goal command to a previously active module.
  const other = await vscode.workspace.openTextDocument({ content: 'ordinary text', language: 'plaintext' });
  await vscode.window.showTextDocument(other);
  await assert.rejects(runCommand('refine'), /active editor is not an Agda/);
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  await until(() => companion.getPersistedState()?.lastCommand?.action === invalid.action, 'saved command receipt');
  const modeRoot = vscode.extensions.getExtension('banacorn.agda-mode')!.extensionPath;
  const result = {
    date: new Date().toISOString(), machine: { cpu: os.cpus()[0]!.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), kernel: os.release(), loadAverage: os.loadavg() },
    vscode: vscode.version, node: process.version, agdaMode: modeVersion,
    activationBodyMs: api.activationMs, activationCallMs,
    windowTitles: titles, modeRoot, module: 'Overture.Basic',
    commands: { load, context, highlighting, give, refine, invalid },
    panelOpened: true, webviewStateSaved: true, versionWarning: !status.supported,
    reloadRestored: false,
  };
  await writeFile(path.join(output, `${phase}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS: ${phase}, real load/give/refine, highlighting, rejected candidate, panel focus`);
}

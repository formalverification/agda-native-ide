// File: vscode/src/test/host.ts

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Companion, DocumentSnapshot, LaneResult } from '../extension';

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

/** The native lanes (issue 64) on the module the mode has just loaded, with
 * its one goal, `ℓ₁ = suc {!   !}`: its verdict; the goal's type and
 * context at the cursor, from a lane started and loaded for it, then warm;
 * an inference in the goal; a give of a term written in the goal, which
 * edits and saves the file; and the verdict again, now that it checks. */
async function nativeLanes(companion: Companion, document: vscode.TextDocument): Promise<Record<string, unknown>> {
  const lane = async (action: string, argument?: string) => {
    const result = await deadline(vscode.commands.executeCommand<LaneResult>(`agdaWorkbench.${action}`, argument), action, 300000);
    assert.equal(result.text, document.getText());
    assert.equal(document.isDirty, false, `${action} leaves the module saved`);
    return result;
  };
  const text = () => document.getText();
  const goalAt = () => text().indexOf('{!', text().indexOf('ℓ₁ ='));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  assert.match(text(), /ℓ₁ = suc \{!\s*!\}/);

  const before = await lane('checkFile');
  assert.ok(before.result.status === 'verdict', JSON.stringify(before.result));
  const open = before.result as Extract<typeof before.result, { status: 'verdict' }>;
  type Diagnostics = Array<{ severity: string; code?: string; file?: string }>;
  const openResult = open.result as { success: boolean; checking: string[]; diagnostics: Diagnostics };
  assert.equal(open.verdict.exitCode, 42);
  assert.equal(openResult.success, false);
  const errors = (diagnostics: Diagnostics) => diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => diagnostic.code);
  assert.deepEqual(errors(openResult.diagnostics), ['UnsolvedInteractionMetas']);
  assert.match(companion.getVerdictStatus().text, /exit 42/);

  editor.selection = new vscode.Selection(document.positionAt(goalAt() + 3), document.positionAt(goalAt() + 3));
  const first = await lane('laneGoal');
  assert.ok(first.result.status === 'answer', JSON.stringify(first.result));
  assert.equal((first.result.result as { type: string }).type, 'Level');
  assert.equal(first.load, 'first');
  assert.equal(first.spawned, false, 'the verdict started the lane');
  const warm = await lane('laneGoal');
  assert.equal(warm.load, 'reused');
  assert.ok(warm.result.status === 'answer');
  assert.match(companion.getAnswer() ?? '', /^Goal \d+: Level/);
  const inferred = await lane('laneInfer', 'suc 0ℓ');
  assert.ok(inferred.result.status === 'answer');
  assert.equal((inferred.result.result as { type: string }).type, 'Level');

  // The term is written in the goal, as for the mode's give.
  const hole = goalAt();
  await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(hole), document.positionAt(text().indexOf('!}', hole) + 2)), '{! 0ℓ !}'));
  editor.selection = new vscode.Selection(document.positionAt(hole + 3), document.positionAt(hole + 3));
  const give = await lane('laneGive');
  assert.ok(give.result.status === 'answer' && give.result.tool === 'give', JSON.stringify(give.result));
  assert.deepEqual(give.result.result, { goal: (give.result.result as { goal: number }).goal, term: '0ℓ', accepted: true, applied: true });
  assert.equal(give.documentChanged, true);
  assert.ok(text().includes('ℓ₁ = suc 0ℓ') && !text().includes('ℓ₁ = suc {!'));

  const after = await lane('checkFile');
  assert.ok(after.result.status === 'verdict');
  assert.equal(after.result.verdict.exitCode, 0);
  assert.equal((after.result.result as { success: boolean }).success, true);
  assert.match(companion.getVerdictStatus().text, /exit 0/);
  assert.equal(companion.getLanes().length, 1, 'one lane for the workspace');
  // The module the later checks read keeps its goal, as the mode left it.
  const given = text().indexOf('suc 0ℓ', text().indexOf('ℓ₁ =')) + 'suc '.length;
  await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(given), document.positionAt(given + '0ℓ'.length)), '{!   !}'));
  await document.save();

  const time = (result: LaneResult) => Math.round(result.elapsedMs * 10) / 10;
  const agda = (result: LaneResult) => Math.round((result.result as { elapsedMs: number }).elapsedMs * 10) / 10;
  const checked = (result: LaneResult) => (result.result as { result: { checking: string[] } }).result.checking;
  // What the run's warnings were, and which files they name.
  const warnings = (result: LaneResult) => {
    const counts: Record<string, number> = {};
    for (const diagnostic of (result.result as { result: { diagnostics: Diagnostics } }).result.diagnostics) {
      if (diagnostic.severity !== 'warning') continue;
      const key = `${diagnostic.code} in ${path.basename(diagnostic.file ?? '?')}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
  return {
    verdictBefore: {
      exitCode: 42, agdaMs: agda(before), commandMs: time(before), checking: checked(before),
      warnings: warnings(before), spawnedLane: before.spawned,
    },
    firstGoal: { load: first.load, loadMs: first.loadMs, checking: first.checking, agdaMs: agda(first), commandMs: time(first) },
    warmGoal: { load: warm.load, agdaMs: agda(warm), commandMs: time(warm) },
    infer: { agdaMs: agda(inferred), commandMs: time(inferred) },
    give: { load: give.load, loadMs: give.loadMs, agdaMs: agda(give), commandMs: time(give) },
    verdictAfter: { exitCode: 0, agdaMs: agda(after), commandMs: time(after), checking: checked(after), warnings: warnings(after) },
  };
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
  await assert.rejects(runCommand('highlighting'), /Load the module with Agda Workbench/);
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
  panel.reveal(undefined, false);
  await until(() => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab?.input instanceof vscode.TabInputWebview && tab.label === panel.title;
  }, 'panel focus');
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
  const lanes = phase === 'supported' ? await nativeLanes(companion, document) : null;
  const probeUri = vscode.Uri.joinPath(root, 'TokenProbe.agda');
  await vscode.workspace.fs.writeFile(probeUri, Buffer.from('module TokenProbe where\n'));
  const probe = await vscode.workspace.openTextDocument(probeUri);
  await vscode.workspace.getConfiguration('editor', probeUri).update('semanticHighlighting.enabled', false, vscode.ConfigurationTarget.Workspace);
  await vscode.window.showTextDocument(probe, { viewColumn: vscode.ViewColumn.One });
  let providerCalls = 0;
  const requests: Array<(tokens: vscode.SemanticTokens) => void> = [];
  const provider = vscode.languages.registerDocumentSemanticTokensProvider(
    { language: 'agda', scheme: 'file', pattern: probeUri.fsPath },
    { provideDocumentSemanticTokens() {
      providerCalls++;
      return new Promise<vscode.SemanticTokens>(resolve => requests.push(resolve));
    } },
    new vscode.SemanticTokensLegend(['variable'], []),
  );
  try {
    for (let retry = 0; retry < 3; retry++) {
      await assert.rejects(Promise.resolve(vscode.commands.executeCommand('agdaWorkbench.highlighting')), /Load the module with Agda Workbench/);
    }
    assert.equal(providerCalls, 0, 'no provider request before companion load');
    await deadline(vscode.commands.executeCommand('agdaWorkbench.load'), 'load provider probe');
    for (let retry = 0; retry < 3; retry++) {
      await assert.rejects(Promise.resolve(vscode.commands.executeCommand('agdaWorkbench.highlighting')), /Highlighting is still pending/);
    }
    assert.equal(providerCalls, 1, 'retries must share the uncancellable provider request');
    const tokens = new vscode.SemanticTokens(new Uint32Array([0, 0, 6, 0, 0]));
    requests[0]!(tokens);
    await new Promise(resolve => setTimeout(resolve, 50));
    const next = deadline(vscode.commands.executeCommand('agdaWorkbench.highlighting'), 'fresh tokens after late settlement');
    await until(() => providerCalls === 2, 'a settled request permits a fresh read');
    requests[1]!(tokens);
    await next;
    assert.equal(companion.getState().lastCommand?.tokenCount, 1);
  } finally { provider.dispose(); }
  const modeRoot = vscode.extensions.getExtension('banacorn.agda-mode')!.extensionPath;
  const result = {
    date: new Date().toISOString(), machine: { cpu: os.cpus()[0]!.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), kernel: os.release(), loadAverage: os.loadavg() },
    vscode: vscode.version, node: process.version, agdaMode: modeVersion,
    activationBodyMs: api.activationMs, activationCallMs,
    windowTitles: titles, modeRoot, module: 'Overture.Basic',
    commands: { load, context, highlighting, give, refine, invalid },
    nativeLanes: lanes,
    panelOpened: true, webviewStateSaved: true, versionWarning: !status.supported,
    reloadRestored: false,
    highlightingRequestsShared: true,
  };
  await writeFile(path.join(output, `${phase}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS: ${phase}, real load/give/refine, highlighting, rejected candidate, panel focus${lanes ? ', native lanes' : ''}`);
}

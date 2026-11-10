// File: vscode/src/test/projects.ts
//
// Each project's own Agda in one window (issue 99): a multi-root workspace
// of three small libraries, written by scripts/run-tests.mjs, whose
// agda-for-project (the flake's package) decides alpha's Agda as the
// .#vscode shell's 2.9.0 and beta's as nixpkgs' 2.8.0, each a choice made
// before the window opens, and decides nothing for gamma (no flake, no
// choice).  agda-mode-vscode names the launcher as its one path, and the
// mode and the native lanes are driven on a file of each, in the order
// COMPANION_PROJECT_ORDER gives.  Which Agda checked a file is read from
// the disk: Agda writes a module's interface under _build/<version>/.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Companion, DocumentSnapshot, LaneResult } from '../extension';
import { listProcesses, modeAgda } from '../project';

function deadline<T>(promise: Thenable<T>, label: string, ms = 120000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  await deadline((async () => {
    while (!predicate()) await new Promise(resolve => setTimeout(resolve, 50));
  })(), label, 60000);
}

const capital = (name: string) => name[0]!.toUpperCase() + name.slice(1);
const folder = (name: string) => vscode.workspace.workspaceFolders!.find(each => each.name === name)!.uri.fsPath;
/** The versions whose Agda wrote the library's base interface. */
const checkedBy = (name: string, versions: string[]) =>
  versions.filter(version => existsSync(path.join(folder(name), `_build/${version}/agda/${capital(name)}Base.agdai`)));

async function show(name: string, module = capital(name)): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(path.join(folder(name), `${module}.agda`));
  return vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
}

export async function run(): Promise<void> {
  const output = process.env.COMPANION_TEST_OUTPUT!;
  const order = process.env.COMPANION_PROJECT_ORDER!.split(',');
  const agdas = JSON.parse(process.env.COMPANION_PROJECT_AGDAS!) as Record<string, { path: string; version: string }>;
  const versions = Object.values(agdas).map(agda => agda.version);
  const extension = vscode.extensions.getExtension<{ companion: Companion }>('formalverification.agda-native-ide')!;
  const companion = (await extension.activate()).companion;
  const steering = companion.steering;
  const settled = async (name: string) => {
    await until(() => steering.getFollowed()?.root === folder(name) &&
      (steering.getFollowed()?.answer !== undefined || steering.getFollowed()?.error !== undefined), `the companion follows ${name}`);
    await deadline(steering.idle(), `the companion settles on ${name}`);
  };
  const running = async () => modeAgda(await listProcesses(), process.pid);
  /** The version of the Agda the mode runs, asked of its executable (a
   * wrapper such as nixpkgs' execs the real one, whose path this is). */
  const versionOf = (args: string) => execFileSync(args.split(' ')[0]!, ['--numeric-version'], { encoding: 'utf8' }).trim();
  const lane = async (action: string) => deadline(vscode.commands.executeCommand<LaneResult>(`agdaWorkbench.${action}`), action);
  const record: Record<string, unknown> = { order, agdas };
  const steps: unknown[] = [];

  // A file of each project, in the order given: its status, the mode's
  // restart when it ran the other project's Agda, a load through the mode,
  // the Agda that checked it, and the lanes on it.
  for (const name of order) {
    const { version } = agdas[name]!;
    const restartsBefore = steering.restarts.length;
    const before = await running();
    const editor = await show(name);
    await settled(name);
    const status = steering.getStatus();
    assert.equal(status.text, `$(versions) Agda ${version}`, `${name}'s status`);
    assert.match(status.tooltip, /decided by your choice, path:/);
    const restarted = steering.restarts.length - restartsBefore;
    // The mode restarts only when it ran an Agda for the other project.
    assert.equal(restarted, before ? 1 : 0, `${name}: restarts`);
    const started = performance.now();
    const loaded = await deadline(vscode.commands.executeCommand<DocumentSnapshot>('agdaWorkbench.load'), `load ${name}`);
    const loadMs = Math.round(performance.now() - started);
    assert.equal(loaded.uri, editor.document.uri.toString());
    assert.deepEqual(checkedBy(name, versions), [version], `${name} was checked by Agda ${version} alone`);
    const mode = await running();
    assert.ok(mode, 'the mode runs an Agda');
    assert.equal(versionOf(mode.args), version, `the mode runs ${name}'s Agda: ${mode.args}`);
    const verdict = await lane('checkFile');
    assert.ok(verdict.result.status === 'verdict', JSON.stringify(verdict.result));
    assert.equal(verdict.result.verdict.exitCode, 42, 'the open goal');
    const text = editor.document.getText();
    const goal = editor.document.positionAt(text.indexOf('{!') + 2);
    editor.selection = new vscode.Selection(goal, goal);
    const answered = await lane('laneGoal');
    assert.ok(answered.result.status === 'answer', JSON.stringify(answered.result));
    assert.equal((answered.result.result as { type: string }).type, 'N');
    const lanes = companion.getLanes().find(each => each.root === folder(name));
    assert.ok(lanes, `a lane for ${name}`);
    steps.push({
      name, version, status: status.text, restarted, loadMs, mode: mode.args.split(' ')[0],
      verdict: { exitCode: verdict.result.verdict.exitCode, agdaMs: Math.round(verdict.result.elapsedMs) },
      goal: { type: 'N', load: answered.load, commandMs: Math.round(answered.elapsedMs) },
    });
  }

  // Back to the first: a restart; then another file of the same project:
  // none, and the same Agda.
  const first = order[0]!;
  let restartsBefore = steering.restarts.length;
  await show(first);
  await settled(first);
  assert.equal(steering.restarts.length - restartsBefore, 1, `back to ${first}: one restart`);
  const back = await running();
  assert.ok(back && versionOf(back.args) === agdas[first]!.version, `the mode runs ${first}'s Agda again: ${back?.args}`);
  restartsBefore = steering.restarts.length;
  await show(first, `${capital(first)}Base`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await deadline(steering.idle(), 'the companion settles on the base');
  assert.equal(steering.restarts.length, restartsBefore, 'a file of the same project restarts nothing');
  assert.equal((await running())?.pid, back?.pid);
  steps.push({ name: first, again: true, restarted: 1, sameProjectRestarts: 0 });

  // gamma: the launcher decides nothing.  Its one line is shown, the mode
  // is not restarted (its Agda is still the last project's), and the lanes
  // refuse, running no Agda.
  restartsBefore = steering.restarts.length;
  await show('gamma');
  await settled('gamma');
  const refused = steering.getStatus();
  assert.equal(refused.text, '$(warning) Agda: none');
  assert.match(refused.tooltip, /^no flake\.nix at or above .*gamma, and no Agda chosen for it/);
  assert.equal(refused.command, 'agdaWorkbench.chooseAgda');
  assert.equal(steering.restarts.length, restartsBefore, 'no restart into a refusal');
  assert.equal((await running())?.pid, back?.pid);
  await assert.rejects(lane('checkFile'), /agda-for-project decided no Agda for .*gamma, and no other is run: no flake\.nix/);

  // The chooser, given an ID as a quick pick's choice would: gamma gets the
  // first project's Agda, the mode restarts on it, and the choice is
  // forgotten again.
  restartsBefore = steering.restarts.length;
  await deadline(vscode.commands.executeCommand('agdaWorkbench.chooseAgda', `path:${agdas[first]!.path}`), 'choose');
  const chosen = steering.getStatus();
  assert.equal(chosen.text, `$(versions) Agda ${agdas[first]!.version}`);
  assert.equal(steering.restarts.length - restartsBefore, 1, 'the mode restarts on the chosen Agda');
  const gammaVerdict = await lane('checkFile');
  assert.ok(gammaVerdict.result.status === 'verdict' && gammaVerdict.result.verdict.exitCode === 42);
  await deadline(vscode.commands.executeCommand('agdaWorkbench.chooseAgda', null), 'forget');
  assert.equal(steering.getStatus().text, '$(warning) Agda: none');
  const resolution = await deadline(vscode.commands.executeCommand<string>('agdaWorkbench.showResolution'), 'show the resolution');
  assert.match(resolution, /no flake\.nix at or above .*gamma/);

  // agdaWorkbench.agda.version, set for beta's folder, overrides the
  // project's version, and a lane on another is refused with the reason.
  const beta = vscode.workspace.getConfiguration('agdaWorkbench', vscode.Uri.file(folder('beta')));
  await show('beta');
  await settled('beta');
  await beta.update('agda.version', '2.9.0', vscode.ConfigurationTarget.WorkspaceFolder);
  await assert.rejects(lane('checkFile'), new RegExp(`agdaWorkbench\\.agda\\.version is 2\\.9\\.0; the project's Agda \\(your choice, path:.*\\) is Agda ${agdas.beta!.version.replace(/\./g, '\\.')}`));
  await beta.update('agda.version', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  record.refusals = { gammaStatus: refused.text, gammaTooltip: refused.tooltip.split('\n')[0], versionOverride: 'refused' };

  // The mode's options reach the lanes too, as the mode passes them to the
  // launcher, which runs them after the project's arguments:
  // --allow-unsolved-metas turns the open goal's exit 42 into 0.
  const options = vscode.workspace.getConfiguration('agdaMode');
  await options.update('connection.commandLineOptions', '--allow-unsolved-metas', vscode.ConfigurationTarget.Global);
  const optioned = await lane('checkFile');
  assert.ok(optioned.result.status === 'verdict' && optioned.result.verdict.exitCode === 0, `the mode's options reach the lanes: ${JSON.stringify(optioned.result)}`);
  await options.update('connection.commandLineOptions', undefined, vscode.ConfigurationTarget.Global);
  const plain = await lane('checkFile');
  assert.ok(plain.result.status === 'verdict' && plain.result.verdict.exitCode === 42, 'and leave with them');

  // A restart skipped because focus left the file before its follow ended
  // is tried again at the next focus of that project, its answer cached.
  await deadline(vscode.commands.executeCommand('agdaWorkbench.load'), 'load beta');
  assert.equal(versionOf((await running())!.args), agdas.beta!.version, 'the mode runs beta\'s Agda');
  restartsBefore = steering.restarts.length;
  const prose = await vscode.workspace.openTextDocument({ content: 'not Agda\n' });
  const alphaDocument = await vscode.workspace.openTextDocument(path.join(folder('alpha'), 'Alpha.agda'));
  void vscode.window.showTextDocument(alphaDocument, { viewColumn: vscode.ViewColumn.One, preview: false });
  await vscode.window.showTextDocument(prose, { viewColumn: vscode.ViewColumn.One, preview: false });
  await settled('alpha');
  assert.equal(steering.restarts.length, restartsBefore, 'focus left alpha before its restart');
  assert.equal(versionOf((await running())!.args), agdas.beta!.version, 'so the mode still runs beta\'s Agda');
  await show('alpha');
  await settled('alpha');
  assert.equal(steering.restarts.length - restartsBefore, 1, 'the skipped restart is tried again');
  assert.equal(versionOf((await running())!.args), agdas.alpha!.version, 'and the mode runs alpha\'s Agda');
  record.lanesTakeModeOptions = { withOption: optioned.result.verdict.exitCode, without: plain.result.verdict.exitCode };
  record.skippedRestartRetried = true;

  // The mode's own Switch Agda Version: its pick, kept in the mode's
  // workspace state, overrides its paths, so the mode no longer runs the
  // launcher.  Chosen from the chooser, it stops the steering: no restart
  // across projects, and the status says the mode runs another Agda while
  // the lanes keep the project's.  Resumed while the pick still stands (as
  // after a pick made from the mode's own command), one restart shows the
  // mode running another version, and the steering stops again.
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const modeSettings = vscode.workspace.getConfiguration('agdaMode');
  const launcherPath = modeSettings.get<string[]>('connection.paths')!.at(-1)!;
  const [steered, picked] = [agdas.alpha!, agdas.beta!];
  await modeSettings.update('connection.paths', [picked.path, launcherPath], vscode.ConfigurationTarget.Global);
  await show('alpha');
  await settled('alpha');
  await deadline(vscode.commands.executeCommand('agdaWorkbench.load'), 'load alpha');
  assert.equal(versionOf((await running())!.args), steered.version, 'the mode runs alpha\'s Agda');
  // The mode's list is its paths, last first: the launcher, then the pick.
  const switching = vscode.commands.executeCommand('agdaWorkbench.chooseAgda', 'mode');
  await pause(3000);
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await pause(500);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await deadline(switching, 'the mode\'s Switch Agda Version');
  await pause(2000);
  assert.equal(steering.steersMode(), false, 'the mode\'s own pick stops the steering');
  await deadline(vscode.commands.executeCommand('agdaWorkbench.load'), 'load alpha on the pick');
  assert.equal(versionOf((await running())!.args), picked.version, 'the mode runs its pick');
  restartsBefore = steering.restarts.length;
  await show('beta');
  await settled('beta');
  await show('alpha');
  await settled('alpha');
  assert.equal(steering.restarts.length, restartsBefore, 'no restart while the mode runs its own pick');
  const ownStatus = steering.getStatus();
  assert.equal(ownStatus.text, `$(warning) Agda ${steered.version}`);
  assert.match(ownStatus.tooltip, new RegExp(`Agda mode runs Agda ${picked.version.replace(/\./g, '\\.')}, `));
  assert.match(ownStatus.tooltip, /Agda mode runs an Agda of its own/);
  const ownVerdict = await lane('checkFile');
  assert.ok(ownVerdict.result.status === 'verdict' && ownVerdict.result.verdict.exitCode === 42, 'the lanes keep the project\'s Agda');
  await deadline(vscode.commands.executeCommand('agdaWorkbench.chooseAgda', 'steer'), 'steer again');
  assert.equal(steering.restarts.length - restartsBefore, 1, 'steering again restarts the mode once');
  assert.equal(steering.steersMode(), false, 'the pick still stands, so the steering stops again');
  assert.equal(steering.getStatus().text, `$(warning) Agda ${steered.version}`);
  restartsBefore = steering.restarts.length;
  await show('beta');
  await settled('beta');
  await show('alpha');
  await settled('alpha');
  assert.equal(steering.restarts.length, restartsBefore, 'and restarts nothing after');
  record.ownPick = { status: ownStatus.text, tooltip: ownStatus.tooltip.split('\n').filter(line => line.startsWith('Agda mode')), steerAgainRestarts: 1 };
  record.steps = steps;
  record.restarts = steering.restarts.length;
  await writeFile(path.join(output, `projects-${order.join('-')}.json`), JSON.stringify(record, null, 2) + '\n');
}

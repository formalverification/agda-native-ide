// File: vscode/src/steering.ts
//
// Each project's own Agda in VS Code (issue 99): agda-mode-vscode and the
// native lanes run the active file's project's Agda, as agda-for-project
// (issue 97) decides it.
//
// How the mode is steered, and why (the findings on issue 99, from the
// mode's source at 0.10.4 and a run in the extension host for each):
//
//   +  The mode keeps one Agda for the whole window, and reads
//      agdaMode.connection.paths without a resource, so a folder's own
//      setting is ignored: no setting can differ between two projects of
//      one window.  It spawns Agda through a shell in the extension host's
//      working directory, one per window, which every extension shares.
//   +  It spawns with the extension host's environment as it is at the
//      spawn.  agda-for-project reads AGDA_FOR_PROJECT_DIR, when set, in
//      place of its working directory, for a host that cannot choose where
//      it starts Agda.  So the companion names the launcher once, as the
//      mode's Agda (a user setting, written only on consent), and sets that
//      one variable in the extension host to the active file's project.
//      Only agda-for-project reads it; the companion's own lanes, the one
//      other host of the launcher here, run the resolved Agda directly and
//      never inherit it.
//   +  `agda-mode.restart` kills the mode's Agda and loads the active file
//      with a new one.  The companion restarts the mode only when the
//      active file's project needs another Agda (another program,
//      arguments or environment) than the one the variable named, and
//      only while the mode runs one; a change of focus within a project,
//      or to a project on the same Agda, restarts nothing.
//   +  The mode probes `--version` with a 3 s timeout, which any output
//      clears; a silent first build longer than that makes it pass over
//      the launcher for its next candidate.  So the companion builds first,
//      with `--explain` behind a progress notification, and restarts the
//      mode only after the build.  When the launcher decides nothing, the
//      companion shows its one line and restarts nothing.
//
// Rejected: a setting written per folder (ignored by the mode) or per
// change of project (a write into the user's settings at every switch);
// and process.chdir in the shared extension host (every extension's
// relative paths would move).

import { dirname, basename } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { findProjectRoot, locateExecutable } from '@agda-native-ide/engine/native';
import {
  candidates, choose, decidedHow, explain, launcherName, libraryDepends, listProcesses, modeAgda, modeLauncher,
  runKey, runLauncher, starterFlake, type Explained, type Process,
} from './project';

const variable = 'AGDA_FOR_PROJECT_DIR';
const offerKey = 'agdaWorkbench.steeringOffer';
const progressAfterMs = 400;

function isAgdaFile(document: vscode.TextDocument): boolean {
  return (document.languageId === 'agda' || document.languageId === 'lagda-markdown') && document.uri.scheme === 'file';
}

/** What the companion knows of the active project. */
export interface Followed {
  file: string;
  /** The project's root, as findProjectRoot has it (the lanes' root). */
  root: string;
  answer?: Explained;
  /** Why there is no answer: the launcher's one line, or why it did not run. */
  error?: string;
  /** How long the answer took (a build, the first time). */
  explainMs?: number;
}

export class Steering implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Each project's answer, by its root, built once; cleared when a file
   * that decides an Agda changes, or a choice is made. */
  private readonly answers = new Map<string, Promise<Explained>>();
  private readonly original = process.env[variable];
  private followed: Followed | undefined;
  private following: Promise<void> = Promise.resolve();
  private sequence = 0;
  /** The key of the resolution the variable names, which the mode's next
   * spawn runs. */
  private envKey: string | undefined;
  private offered = false;
  /** The mode's restarts: the project each was for, the process it
   * replaced, and how long the restart and its load took. */
  readonly restarts: Array<{ root: string; replaced: number; ms?: number }> = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('agdaWorkbench.agda', vscode.StatusBarAlignment.Left, 101);
    this.status.name = 'Agda Workbench: the project\'s Agda';
    this.output = vscode.window.createOutputChannel('Agda Workbench: Agda resolution');
    const watcher = vscode.workspace.createFileSystemWatcher('**/{flake.nix,flake.lock,*.agda-lib}');
    const changed = () => { this.answers.clear(); this.refollow(); };
    this.subscriptions.push(
      this.status, this.output, watcher,
      watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
      vscode.window.onDidChangeActiveTextEditor(editor => this.track(editor)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('agdaMode.connection.paths') || event.affectsConfiguration('agdaWorkbench')) {
          this.answers.clear();
          this.refollow();
        }
      }),
    );
    this.track(vscode.window.activeTextEditor);
  }

  /** The launcher the companion runs for a file: agdaWorkbench.launcher.path,
   * else the one agda-mode-vscode runs (the last of its paths), else none,
   * and then the lanes run what the mode's settings name, as before. */
  launcher(uri?: vscode.Uri): string | undefined {
    const own = vscode.workspace.getConfiguration('agdaWorkbench', uri).get<string>('launcher.path')?.trim();
    return own || modeLauncher(vscode.workspace.getConfiguration('agdaMode').get('connection.paths'));
  }

  /** Whether the mode runs the launcher, so that the variable decides its
   * Agda: the last of its paths names it, and steering is not turned off. */
  steersMode(): boolean {
    return vscode.workspace.getConfiguration('agdaWorkbench').get<boolean>('mode.steer') !== false &&
      modeLauncher(vscode.workspace.getConfiguration('agdaMode').get('connection.paths')) !== undefined;
  }

  getFollowed(): Followed | undefined { return this.followed; }
  getStatus(): { text: string; tooltip: string; command: string | undefined } {
    const tooltip = this.status.tooltip;
    return {
      text: this.status.text, tooltip: typeof tooltip === 'string' ? tooltip : tooltip?.value ?? '',
      command: typeof this.status.command === 'string' ? this.status.command : this.status.command?.command,
    };
  }
  /** Settles when the companion has followed the last change of editor. */
  idle(): Promise<void> { return this.following; }

  /** A file's Agda, from the launcher, built once per project root. */
  answerFor(file: string, root: string): Promise<Explained> {
    let answer = this.answers.get(root);
    if (!answer) {
      const launcher = this.launcher(vscode.Uri.file(file));
      if (!launcher) return Promise.reject(new Error('no agda-for-project is configured'));
      answer = explain(launcher, file);
      this.answers.set(root, answer);
      answer.catch(() => { if (this.answers.get(root) === answer) this.answers.delete(root); });
    }
    return answer;
  }

  private track(editor: vscode.TextEditor | undefined): void {
    if (!editor || !isAgdaFile(editor.document)) return;
    const file = editor.document.uri.fsPath;
    this.followFile(file);
  }

  private refollow(): void {
    if (this.followed) this.followFile(this.followed.file, true);
  }

  private followFile(file: string, force = false): void {
    const sequence = ++this.sequence;
    this.following = this.following.then(() => this.follow(file, sequence, force)).catch(error => {
      this.output.appendLine(`[follow] ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async follow(file: string, sequence: number, force: boolean): Promise<void> {
    if (sequence !== this.sequence) return;
    const uri = vscode.Uri.file(file);
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const root = (await findProjectRoot(file, folder)).root;
    const launcher = this.launcher(uri);
    if (!launcher) {
      this.followed = { file, root };
      this.status.hide();
      void this.offerSteering();
      return;
    }
    if (!force && this.followed?.root === root && this.followed.answer) {
      this.followed.file = file;
      return;
    }
    const steering = this.steersMode();
    // The next spawn of the mode is for this project, even before its
    // build ends: a load meanwhile runs the launcher, which waits for it.
    if (steering) process.env[variable] = root;
    this.followed = { file, root };
    this.showBuilding(root);
    let answer: Explained;
    const asked = performance.now();
    try {
      answer = await this.withProgress(root, this.answerFor(file, root));
      this.followed.explainMs = Math.round(performance.now() - asked);
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.followed.error = error instanceof Error ? error.message : String(error);
      this.showError(this.followed.error);
      return;
    }
    if (sequence !== this.sequence) return;
    this.followed.answer = answer;
    if (!answer.decided) {
      this.followed.error = answer.error ?? 'agda-for-project decided nothing';
      this.showError(this.followed.error);
      // The launcher refused: show its line, and run no other Agda.
      void vscode.window.showWarningMessage(`${basename(root)}: ${this.followed.error}`, 'Choose an Agda…').then(pick => {
        if (pick) void vscode.commands.executeCommand('agdaWorkbench.chooseAgda');
      });
      if (steering) this.envKey = `refused ${root}`;
      return;
    }
    const mode = steering ? await this.modeProcess() : undefined;
    this.showAnswer(answer, mode);
    if (!steering) return;
    process.env[variable] = answer.project.root;
    const key = runKey(answer);
    const previous = this.envKey;
    this.envKey = key;
    if (key === previous || !mode) return;
    await this.restartMode(file, root, mode);
  }

  /** The mode's Agda, if it runs one. */
  private async modeProcess(): Promise<Process | undefined> {
    return modeAgda(await listProcesses(), process.pid);
  }

  /** Restart the mode on the file, which the restart loads: it acts on the
   * active editor. */
  private async restartMode(file: string, root: string, running: Process): Promise<void> {
    const active = vscode.window.activeTextEditor;
    if (active?.document.uri.fsPath !== file) return;
    if (!(await vscode.commands.getCommands(true)).includes('agda-mode.restart')) return;
    const restart: { root: string; replaced: number; ms?: number } = { root, replaced: running.pid };
    this.restarts.push(restart);
    const started = performance.now();
    await vscode.commands.executeCommand('agda-mode.restart');
    restart.ms = Math.round(performance.now() - started);
    if (this.followed?.answer) this.showAnswer(this.followed.answer, await this.modeProcess());
  }

  /** The build behind a progress notification, shown only if it takes
   * longer than a warm start. */
  private async withProgress<T>(root: string, work: Promise<T>): Promise<T> {
    const settled = await Promise.race([work.then(() => true, () => true), new Promise(done => setTimeout(() => done(false), progressAfterMs))]);
    if (settled) return work;
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Agda Workbench: building the Agda of ${basename(root)} (agda-for-project --explain)`,
    }, () => work);
  }

  private showBuilding(root: string): void {
    this.status.text = '$(sync~spin) Agda';
    this.status.tooltip = `Finding the Agda of ${root} (agda-for-project --explain)`;
    this.status.command = 'agdaWorkbench.showResolution';
    this.status.show();
  }

  private showAnswer(answer: Explained, mode: Process | undefined): void {
    this.status.text = `$(versions) Agda ${answer.version ?? '?'}`;
    this.status.tooltip = [
      `${answer.project.root}: Agda ${answer.version ?? '?'}, decided by ${decidedHow(answer)} (agda-for-project)`,
      `${answer.program ?? '(not built)'}${answer.args.length ? ` ${answer.args.join(' ')}` : ''}`,
      ...(mode ? [`Agda mode runs ${mode.args} (pid ${mode.pid})`] : []),
      'Click for the resolution.',
    ].join('\n');
    this.status.command = 'agdaWorkbench.showResolution';
    this.status.show();
  }

  private showError(error: string): void {
    this.status.text = '$(warning) Agda: none';
    this.status.tooltip = `${error}\nClick to choose an Agda.`;
    this.status.command = 'agdaWorkbench.chooseAgda';
    this.status.show();
  }

  /** Offer, once, to name the launcher as the mode's Agda: a write into the
   * user's settings, so it is asked for and never done silently. */
  private async offerSteering(): Promise<void> {
    if (this.offered || this.context.globalState.get(offerKey) === 'never') return;
    const own = vscode.workspace.getConfiguration('agdaWorkbench').get<string>('launcher.path')?.trim();
    const launcher = own || (await locateExecutable(launcherName) ? launcherName : undefined);
    if (!launcher) return;
    this.offered = true;
    const setting = vscode.workspace.getConfiguration('agdaMode').inspect<string[]>('connection.paths');
    const now = JSON.stringify(setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue ?? setting?.defaultValue ?? []);
    if (setting?.workspaceValue !== undefined || setting?.workspaceFolderValue !== undefined) {
      void vscode.window.showInformationMessage(
        `Agda Workbench can have Agda mode start each project's own Agda through ${launcher}, but this workspace's own settings set agdaMode.connection.paths (${now}); set it there to ["${launcher}"] to use it.`);
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `Agda mode starts one Agda for every file (agdaMode.connection.paths is ${now}).  Agda Workbench can have it start each project's own Agda through ${launcher} instead, by setting agdaMode.connection.paths to ["${launcher}"] in your user settings.`,
      'Set It', 'Not Now', 'Don\'t Ask Again');
    if (pick === 'Set It') {
      await vscode.workspace.getConfiguration('agdaMode').update('connection.paths', [launcher], vscode.ConfigurationTarget.Global);
    } else if (pick === 'Don\'t Ask Again') {
      await this.context.globalState.update(offerKey, 'never');
    }
  }

  private activeFile(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && isAgdaFile(editor.document)) return editor.document.uri.fsPath;
    return this.followed?.file;
  }

  /** agda-for-project --explain, as text, in the output channel. */
  async showResolution(): Promise<string> {
    const file = this.activeFile();
    if (!file) throw new Error('Open an Agda module to see its Agda.');
    const launcher = this.launcher(vscode.Uri.file(file));
    if (!launcher) throw new Error('No agda-for-project is configured: set agdaWorkbench.launcher.path, or name it in agdaMode.connection.paths.');
    const ran = await runLauncher(launcher, ['--explain', file]);
    const text = `$ ${launcher} --explain ${file}\n${ran.stdout}${ran.stderr}${ran.code === 0 ? '' : `(exit ${ran.code ?? '?'})\n`}`;
    this.output.appendLine(text);
    this.output.show(true);
    return text;
  }

  /** Choose the active project's Agda: a quick pick of the launcher's
   * candidates (or `id`, without asking), remembered with --choose; beside
   * them, forgetting the choice, the mode's own Switch Agda Version, and a
   * starter flake.nix for a project with none. */
  async chooseAgda(id?: unknown): Promise<string | undefined> {
    const file = this.activeFile();
    if (!file) throw new Error('Open an Agda module to choose its Agda.');
    const launcher = this.launcher(vscode.Uri.file(file));
    if (!launcher) throw new Error('No agda-for-project is configured: set agdaWorkbench.launcher.path, or name it in agdaMode.connection.paths.');
    let chosen: string | null | undefined = typeof id === 'string' ? id : id === null ? null : undefined;
    if (chosen === undefined) {
      const offered = await candidates(launcher, file);
      const answer = this.followed?.answer;
      type Item = vscode.QuickPickItem & { action: string };
      const items: Item[] = offered.map(candidate => ({
        label: `${candidate.chosen ? '$(check) ' : ''}${candidate.kind === 'devshell' ? 'Dev shell' : `Agda ${candidate.version ?? '?'}`}`,
        description: candidate.id,
        detail: candidate.label,
        action: `choose ${candidate.id}`,
      }));
      if (answer?.choice) items.push({ label: '$(close) Forget the choice', description: answer.choice, action: 'forget' });
      items.push({ label: '$(tools) Agda mode: Switch Agda Version…', detail: 'agda-mode-vscode\'s own list, which downloads language servers; it overrides agdaMode.connection.paths for this workspace.', action: 'mode' });
      if (answer && !answer.flake) items.push({ label: '$(new-file) Write a starter flake.nix…', detail: 'Shown first; written into the project only if you confirm.', action: 'flake' });
      const pick = await vscode.window.showQuickPick(items, {
        title: `The Agda of ${answer?.project.root ?? dirname(file)}`,
        placeHolder: 'Choosing a dev shell is consent to run the project\'s shell hook as you.',
        matchOnDescription: true, matchOnDetail: true,
      });
      if (!pick) return undefined;
      if (pick.action === 'mode') { await vscode.commands.executeCommand('agda-mode.switch-agda-version'); return 'mode'; }
      if (pick.action === 'flake') { await this.starterFlake(); return 'flake'; }
      chosen = pick.action === 'forget' ? null : pick.action.slice('choose '.length);
    }
    await choose(launcher, file, chosen);
    this.answers.clear();
    this.followFile(file, true);
    await this.idle();
    return chosen ?? 'forget';
  }

  /** A starter flake.nix for the active project, shown first and written
   * only on consent; then the steps Nix needs, offered in a terminal. */
  async starterFlake(): Promise<string | undefined> {
    const file = this.activeFile();
    if (!file) throw new Error('Open an Agda module of the project first.');
    const project = await findProjectRoot(file, vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath);
    const target = vscode.Uri.joinPath(vscode.Uri.file(project.root), 'flake.nix');
    if (await stat(target.fsPath).then(() => true, () => false)) throw new Error(`${target.fsPath} exists already.`);
    const depends = project.library ? libraryDepends(await readFile(project.library, 'utf8')) : [];
    const { text, missing } = starterFlake(basename(project.root), depends);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'nix', content: text }), { preview: true });
    const write = await vscode.window.showInformationMessage(`Write this flake.nix into ${project.root}?`, {
      modal: true,
      detail: `It writes one file into your checkout.${missing.length ? `  Not in nixpkgs, so left out: ${missing.join(', ')}.` : ''}  Nix reads only the files git tracks, so then run \`git add flake.nix && nix flake lock\` there.`,
    }, 'Write flake.nix');
    if (write !== 'Write flake.nix') return undefined;
    await writeFile(target.fsPath, text, { flag: 'wx' });
    const next = await vscode.window.showInformationMessage(`Wrote ${target.fsPath}.`, 'Open a Terminal There');
    if (next) {
      const terminal = vscode.window.createTerminal({ name: 'agda-for-project', cwd: project.root });
      terminal.show();
      // Typed, not run: the user presses Enter.
      terminal.sendText('git add flake.nix && nix flake lock', false);
    }
    return target.fsPath;
  }

  dispose(): void {
    if (this.original === undefined) delete process.env[variable];
    else process.env[variable] = this.original;
    for (const each of this.subscriptions.splice(0)) each.dispose();
  }
}

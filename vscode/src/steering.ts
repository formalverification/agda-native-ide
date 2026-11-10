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
//   +  The mode's own Switch Agda Version keeps its pick in the mode's
//      workspace state, and that pick overrides agdaMode.connection.paths,
//      so the mode no longer runs the launcher.  Choosing it from the
//      companion's chooser stops the restarts for the workspace, and so
//      does a restart after which the mode runs another version than the
//      launcher gave (the pick made from the mode's own command, which the
//      companion cannot see); the variable still follows the project, the
//      status says so, and the chooser's "Steer Agda mode again" resumes
//      it.
//
// Rejected: a setting written per folder (ignored by the mode) or per
// change of project (a write into the user's settings at every switch);
// and process.chdir in the shared extension host (every extension's
// relative paths would move).

import { execFile } from 'node:child_process';
import { dirname, basename } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { findProjectRoot, locateExecutable } from '@agda-native-ide/engine/native';
import {
  affectsResolution, candidates, choose, decidedHow, explain, launcherName, libraryDepends, listProcesses, modeAgda, modeLauncher,
  resolutionDir, runKey, runLauncher, starterFlake, transient, type Explained, type Process,
} from './project';

const variable = 'AGDA_FOR_PROJECT_DIR';
const offerKey = 'agdaWorkbench.steeringOffer';
/** Set, in the workspace's state, while the mode runs an Agda of its own. */
const ownPickKey = 'agdaWorkbench.modeOwnPick';
const progressAfterMs = 400;

function isAgdaFile(document: vscode.TextDocument): boolean {
  return (document.languageId === 'agda' || document.languageId === 'lagda-markdown') && document.uri.scheme === 'file';
}

/** What the companion knows of the active project. */
export interface Followed {
  file: string;
  /** The project's root, as findProjectRoot has it (the lanes' root). */
  root: string;
  /** The directory the launcher starts from (resolutionDir), which names
   * its answer. */
  dir: string;
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
  /** Each project's answer, by the directory the launcher starts from,
   * built once; cleared when a file the launcher's key covers changes, or
   * a choice is made; a transient refusal (a failed build) is not kept. */
  private readonly answers = new Map<string, Promise<Explained>>();
  private readonly original = process.env[variable];
  private followed: Followed | undefined;
  private following: Promise<void> = Promise.resolve();
  private sequence = 0;
  /** Releases a follow waiting for a build the next follow made stale. */
  private supersede: () => void = () => {};
  /** The file the last follow was queued for. */
  private queued: string | undefined;
  /** The key of the resolution the mode runs, or will at its next spawn:
   * set only once the mode is restarted on it, or runs nothing, so that a
   * restart skipped (focus left the file) is tried again. */
  private envKey: string | undefined;
  private watched: ReturnType<typeof setTimeout> | undefined;
  private offered = false;
  /** The version each mode process answers, by pid. */
  private readonly modeVersions = new Map<number, Promise<string | undefined>>();
  /** The mode's restarts: the project each was for, the process it
   * replaced, and how long the restart and its load took. */
  readonly restarts: Array<{ root: string; replaced: number; ms?: number }> = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('agdaWorkbench.agda', vscode.StatusBarAlignment.Left, 101);
    this.status.name = 'Agda Workbench: the project\'s Agda';
    this.output = vscode.window.createOutputChannel('Agda Workbench: Agda resolution');
    // The launcher's key hashes every tracked file but Agda sources, so a
    // change to any other file may change its answer: ask again, once a
    // burst of changes (a checkout, a save of several) has settled.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = (uri: vscode.Uri) => {
      if (!affectsResolution(uri.fsPath)) return;
      clearTimeout(this.watched);
      this.watched = setTimeout(() => { this.answers.clear(); this.refollow(); }, 250);
    };
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
   * Agda: the last of its paths names it, steering is not turned off, and
   * the mode runs no Agda of its own (a Switch Agda Version pick). */
  steersMode(): boolean {
    return this.namesLauncher() && !this.ownPick();
  }

  private namesLauncher(): boolean {
    return vscode.workspace.getConfiguration('agdaWorkbench').get<boolean>('mode.steer') !== false &&
      modeLauncher(vscode.workspace.getConfiguration('agdaMode').get('connection.paths')) !== undefined;
  }

  private ownPick(): boolean {
    return this.context.workspaceState.get<boolean>(ownPickKey) === true;
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

  /** A file's Agda, from the launcher, built once per directory it starts
   * from (`project` is findProjectRoot's for the file). */
  answerFor(file: string, project: { root: string; source: string }): Promise<Explained> {
    const dir = resolutionDir(file, project);
    let answer = this.answers.get(dir);
    if (!answer) {
      const launcher = this.launcher(vscode.Uri.file(file));
      if (!launcher) return Promise.reject(new Error('no agda-for-project is configured'));
      const asked = explain(launcher, file);
      answer = asked;
      this.answers.set(dir, asked);
      const evict = () => { if (this.answers.get(dir) === asked) this.answers.delete(dir); };
      asked.then(answered => { if (transient(answered)) evict(); }, evict);
    }
    return answer;
  }

  /** The key the mode runs under for an answer: its runKey, or a refusal's. */
  private steeredKey(answer: Explained, dir: string): string {
    return answer.decided ? runKey(answer) : `refused ${dir}`;
  }

  private track(editor: vscode.TextEditor | undefined): void {
    if (!editor || !isAgdaFile(editor.document)) return;
    const file = editor.document.uri.fsPath;
    this.followFile(file);
  }

  private refollow(): void {
    if (this.followed) this.followFile(this.followed.file, true);
  }

  /** Follow a file.  Follows run one at a time, so that the mode's
   * transitions do not overlap; but a follow waiting for a build gives way
   * to the next one, whose project may be built already (the build goes
   * on, and its answer is kept). */
  private followFile(file: string, force = false): void {
    const sequence = ++this.sequence;
    this.queued = file;
    this.supersede();
    const superseded = new Promise<undefined>(done => { this.supersede = () => done(undefined); });
    this.following = this.following.then(() => this.follow(file, sequence, force, superseded)).catch(error => {
      this.output.appendLine(`[follow] ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Settles when the companion has followed `file` (the active editor's,
   * whose change of editor may not have reached it yet): the mode runs its
   * project's Agda, or the launcher's refusal is shown.  The companion's
   * own commands wait for it before they reach the mode. */
  async ready(file: string): Promise<void> {
    if (this.queued !== file && this.launcher(vscode.Uri.file(file))) this.followFile(file);
    // Until no follow is queued behind the one awaited: the one queued here
    // may give way to the editor's own, for the same file.
    for (let chain = this.following; ; chain = this.following) {
      await chain;
      if (chain === this.following) return;
    }
  }

  private async follow(file: string, sequence: number, force: boolean, superseded: Promise<undefined>): Promise<void> {
    if (sequence !== this.sequence) return;
    const uri = vscode.Uri.file(file);
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const project = await findProjectRoot(file, folder);
    const root = project.root;
    const dir = resolutionDir(file, project);
    const launcher = this.launcher(uri);
    if (!launcher) {
      this.followed = { file, root, dir };
      this.restoreVariable();
      this.status.hide();
      void this.offerSteering();
      return;
    }
    const steering = this.steersMode();
    // The same project, and the mode on its Agda (or not steered): nothing
    // to do.  A restart that was skipped leaves the key behind, and so is
    // tried again here.
    if (!force && this.followed?.dir === dir && this.followed.answer &&
        (!steering || this.envKey === this.steeredKey(this.followed.answer, dir))) {
      this.followed.file = file;
      return;
    }
    // The next spawn of the launcher is for this project, even before its
    // build ends: a load meanwhile runs the launcher, which waits for it.
    // So is a probe of the mode's own Switch Agda Version, which is why the
    // variable follows the project even while the mode is not restarted.
    if (this.namesLauncher()) process.env[variable] = dir;
    else this.restoreVariable();
    if (!steering) this.envKey = undefined;
    this.followed = { file, root, dir };
    this.showBuilding(root);
    let answer: Explained;
    const asked = performance.now();
    try {
      const answered = await this.withProgress(root, Promise.race([this.answerFor(file, project), superseded]));
      if (answered === undefined) return;
      answer = answered;
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
      if (steering) this.envKey = this.steeredKey(answer, dir);
      return;
    }
    const mode = this.namesLauncher() ? await this.modeProcess() : undefined;
    await this.showAnswer(answer, mode);
    if (this.namesLauncher()) process.env[variable] = answer.project.root;
    if (!steering) return;
    const key = runKey(answer);
    if (key === this.envKey) return;
    // With no Agda running, the mode's next spawn runs this one.
    if (!mode) { this.envKey = key; return; }
    if (await this.restartMode(file, root, mode) === 'restarted') this.envKey = key;
  }

  /** The mode's Agda, if it runs one. */
  private async modeProcess(): Promise<Process | undefined> {
    return modeAgda(await listProcesses(), process.pid);
  }

  /** Restart the mode on the file, which the restart loads: it acts on the
   * active editor. */
  private async restartMode(file: string, root: string, running: Process): Promise<'restarted' | 'skipped' | 'own'> {
    const active = vscode.window.activeTextEditor;
    if (active?.document.uri.fsPath !== file) return 'skipped';
    if (!(await vscode.commands.getCommands(true)).includes('agda-mode.restart')) return 'skipped';
    const restart: { root: string; replaced: number; ms?: number } = { root, replaced: running.pid };
    this.restarts.push(restart);
    const started = performance.now();
    await vscode.commands.executeCommand('agda-mode.restart');
    restart.ms = Math.round(performance.now() - started);
    const answer = this.followed?.answer;
    if (!answer) return 'restarted';
    // Restarted with the variable on this project, the mode runs the
    // launcher's Agda, unless a Switch Agda Version pick overrides its
    // paths: then it runs another, and steering it only reloads that one.
    const now = await this.modeProcess();
    const version = now ? await this.modeVersion(now) : undefined;
    if (version && answer.version && version !== answer.version) {
      this.output.appendLine(`[steer] restarted for ${root}, Agda mode runs Agda ${version} (${now!.args}), not ${answer.version}: it runs an Agda of its own, and is not steered until "Steer Agda mode again"`);
      await this.context.workspaceState.update(ownPickKey, true);
      this.envKey = undefined;
      await this.showAnswer(answer, now);
      return 'own';
    }
    await this.showAnswer(answer, now);
    return 'restarted';
  }

  /** The version a mode process answers, asked of its executable (a
   * wrapper such as nixpkgs' execs the real one, whose path this is). */
  private modeVersion(mode: Process): Promise<string | undefined> {
    let version = this.modeVersions.get(mode.pid);
    if (!version) {
      version = new Promise(done => execFile(mode.args.split(' ')[0]!, ['--numeric-version'], { encoding: 'utf8', timeout: 10000 },
        (error, stdout) => done(error ? undefined : stdout.trim() || undefined)));
      this.modeVersions.set(mode.pid, version);
    }
    return version;
  }

  /** The variable as it was before the companion set it, and no key: the
   * mode is not steered, and the next steered spawn starts afresh. */
  private restoreVariable(): void {
    if (this.original === undefined) delete process.env[variable];
    else process.env[variable] = this.original;
    this.envKey = undefined;
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

  private async showAnswer(answer: Explained, mode: Process | undefined): Promise<void> {
    const modeVersion = mode ? await this.modeVersion(mode) : undefined;
    const differs = modeVersion !== undefined && answer.version !== null && modeVersion !== answer.version;
    this.status.text = `${differs ? '$(warning)' : '$(versions)'} Agda ${answer.version ?? '?'}`;
    this.status.tooltip = [
      `${answer.project.root}: Agda ${answer.version ?? '?'}, decided by ${decidedHow(answer)} (agda-for-project)`,
      `${answer.program ?? '(not built)'}${answer.args.length ? ` ${answer.args.join(' ')}` : ''}`,
      ...(mode ? [`Agda mode runs ${modeVersion ? `Agda ${modeVersion}, ` : ''}${mode.args} (pid ${mode.pid})`] : []),
      ...(this.ownPick() ? ['Agda mode runs an Agda of its own (a Switch Agda Version pick, which overrides agdaMode.connection.paths), so it is not steered; the native lanes run the project\'s.  Choose an Agda to steer it again.'] : []),
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
    // An ID names a candidate (it has a colon) or one of the other entries,
    // as a quick pick's choice would.
    let action: string | undefined = id === 'mode' || id === 'flake' || id === 'steer' ? id : undefined;
    let chosen: string | null | undefined = action ? undefined : typeof id === 'string' ? id : id === null ? null : undefined;
    if (chosen === undefined && !action) {
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
      if (this.ownPick()) items.push({ label: '$(debug-restart) Steer Agda mode again', detail: 'Pick agda-for-project in Agda mode\'s Switch Agda Version first: its pick overrides agdaMode.connection.paths.', action: 'steer' });
      items.push({ label: '$(tools) Agda mode: Switch Agda Version…', detail: 'agda-mode-vscode\'s own list, which downloads language servers; its pick overrides agdaMode.connection.paths for this workspace, and the companion stops steering the mode.', action: 'mode' });
      if (answer && !answer.flake) items.push({ label: '$(new-file) Write a starter flake.nix…', detail: 'Shown first; written into the project only if you confirm.', action: 'flake' });
      const pick = await vscode.window.showQuickPick(items, {
        title: `The Agda of ${answer?.project.root ?? dirname(file)}`,
        placeHolder: 'Choosing a dev shell is consent to run the project\'s shell hook as you.',
        matchOnDescription: true, matchOnDetail: true,
      });
      if (!pick) return undefined;
      if (pick.action === 'forget') chosen = null;
      else if (pick.action.startsWith('choose ')) chosen = pick.action.slice('choose '.length);
      else action = pick.action;
    }
    if (action === 'mode') {
      // The mode's pick overrides its paths, so it no longer runs the
      // launcher: stop restarting it, for this workspace, as its pick is.
      // The variable still names the project, so that the launcher, if it
      // is the pick, starts this project's Agda.
      await this.context.workspaceState.update(ownPickKey, true);
      this.envKey = undefined;
      await vscode.commands.executeCommand('agda-mode.switch-agda-version');
      this.followFile(file, true);
      await this.idle();
      return 'mode';
    }
    if (action === 'steer') {
      await this.context.workspaceState.update(ownPickKey, undefined);
      this.followFile(file, true);
      await this.idle();
      return 'steer';
    }
    if (action === 'flake') { await this.starterFlake(); return 'flake'; }
    if (chosen === undefined) return undefined;
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
    // The launcher's project: the .agda-lib's directory, else the file's,
    // not a workspace folder that may hold the repository.
    const root = resolutionDir(file, project);
    const target = vscode.Uri.joinPath(vscode.Uri.file(root), 'flake.nix');
    if (await stat(target.fsPath).then(() => true, () => false)) throw new Error(`${target.fsPath} exists already.`);
    const depends = project.library ? libraryDepends(await readFile(project.library, 'utf8')) : [];
    const { text, missing } = starterFlake(basename(root), depends);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'nix', content: text }), { preview: true });
    const write = await vscode.window.showInformationMessage(`Write this flake.nix into ${root}?`, {
      modal: true,
      detail: `It writes one file into your checkout.${missing.length ? `  Not in nixpkgs, so left out: ${missing.join(', ')}.` : ''}  Nix reads only the files git tracks, so then run \`git add flake.nix && nix flake lock\` there.`,
    }, 'Write flake.nix');
    if (write !== 'Write flake.nix') return undefined;
    await writeFile(target.fsPath, text, { flag: 'wx' });
    const next = await vscode.window.showInformationMessage(`Wrote ${target.fsPath}.`, 'Open a Terminal There');
    if (next) {
      const terminal = vscode.window.createTerminal({ name: 'agda-for-project', cwd: root });
      terminal.show();
      // Typed, not run: the user presses Enter.
      terminal.sendText('git add flake.nix && nix flake lock', false);
    }
    return target.fsPath;
  }

  dispose(): void {
    this.restoreVariable();
    for (const each of this.subscriptions.splice(0)) each.dispose();
  }
}

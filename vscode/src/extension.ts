// File: vscode/src/extension.ts
//
// The companion: a panel beside agda-mode-vscode, whose delegated commands
// drive the mode's own (issue 63), and the native engine's two lanes,
// child processes of the extension host (issue 64): an interaction lane
// per project root, which answers a goal's type and context, an
// inference, a normalization and a give at the cursor, and a fresh Agda
// per verdict, whose exit code the panel and the status bar show.  The
// lanes run the Agda the project uses (./resolution.ts) and read the
// module as it is saved: a command saves a dirty buffer first, as the
// mode's own load does, and never sends a buffer, so every answer and
// every verdict names the file on disk.

import * as vscode from 'vscode';
import { LaneRegistry, findProjectRoot, resolveAgda, type FileUse, type LaneConfig, type LaneEnded, type LoadReason } from '@agda-native-ide/engine/native';
import type { Failure, Refusal } from '@agda-native-ide/engine';
import { createToolSurface, type ToolResult } from '@agda-native-ide/tools';
import { describeResult, type GiveResult } from './answers';
import { compatibility, Compatibility } from './compatibility';
import { tokenReader } from './highlighting';
import { panelHtml, panelOptions } from './panel';
import { agdaCandidates } from './resolution';
import { Action, CommandReport, isAction, isLaneAction, LaneAction, laneActions, modeActions, PanelState, restoreState } from './state';

const viewType = 'agdaWorkbench';
const stateKey = 'agdaWorkbench.panelState';
const modeId = 'banacorn.agda-mode';
const modeCommands: Record<Exclude<typeof modeActions[number], 'highlighting'>, string> = {
  load: 'agda-mode.load',
  give: 'agda-mode.give',
  refine: 'agda-mode.refine',
  goalContext: 'agda-mode.goal-type-and-context[Simplified]',
};

const readTokens = tokenReader(uri => vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
  'vscode.provideDocumentSemanticTokens', vscode.Uri.parse(uri),
));

function isAgda(document: vscode.TextDocument): boolean {
  return document.languageId === 'agda' || document.languageId === 'lagda-markdown';
}

export interface DocumentSnapshot {
  uri: string;
  version: number;
  text: string;
}

/** What a native lane command returns. */
export interface LaneResult extends DocumentSnapshot {
  action: LaneAction;
  result: ToolResult | GiveResult;
  /** Whether the lane loaded the module for the command, and why. */
  load?: LoadReason;
  /** That load's time, and the modules it checked (one: the module, when
   * every interface it imports was accepted). */
  loadMs?: number;
  checking?: string[];
  /** Whether the command started the lane's Agda. */
  spawned: boolean;
  elapsedMs: number;
  documentChanged: boolean;
}

/** What a lane command's work yields, before the companion reports it. */
interface LaneOutcome {
  result: ToolResult | GiveResult;
  spawned: boolean;
  load?: LoadReason;
  loadMs?: number;
  checking?: string[];
}

const refused = (tool: string, message: string): ToolResult => ({ tool, status: 'refused', reason: 'invalid-input', message });

export class Companion implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private panel: vscode.WebviewPanel | undefined;
  private panelSubscriptions: vscode.Disposable[] = [];
  private state: PanelState = restoreState(null);
  private target: vscode.TextEditor | undefined;
  private busy = false;
  private error: string | null = null;
  private persisted: PanelState | undefined;
  private snapshot: DocumentSnapshot | undefined;
  private modeCompatibility: Compatibility;
  private readonly loadRequests = new WeakSet<vscode.TextDocument>();
  private readonly previousPanelState: unknown;
  private stateSignature = '';
  private stateWrite: Promise<void> = Promise.resolve();
  /** The native lanes, one per project root. */
  private readonly registry: LaneRegistry;
  /** The Agda versions already asked, by executable. */
  private readonly probes = new Map<string, string>();
  /** The last native lane answer, as the panel shows it, and the module it
   * is about: shown only while the panel follows that module. */
  private answer: { uri: string; text: string } | null = null;
  /** The last verdict's module, which the status bar shows it beside. */
  private verdictUri: string | null = null;
  private readonly verdictItem: vscode.StatusBarItem;
  private shuttingDown: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Capture before editor events or a version warning can open a new panel.
    this.previousPanelState = context.workspaceState.get(stateKey);
    const idleMinutes = vscode.workspace.getConfiguration('agdaWorkbench').get<number>('lanes.idleMinutes') ?? 15;
    this.registry = new LaneRegistry({
      resolve: path => this.resolveLane(path),
      idleMs: Math.max(1, idleMinutes) * 60_000,
      onLaneEnded: ended => this.laneEnded(ended),
    });
    this.verdictItem = vscode.window.createStatusBarItem('agdaWorkbench.verdict', vscode.StatusBarAlignment.Left, 100);
    this.verdictItem.name = 'Agda Workbench verdict';
    this.verdictItem.command = 'agdaWorkbench.open';
    this.modeCompatibility = this.readCompatibility();
    this.track(vscode.window.activeTextEditor, false);
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => this.track(editor)),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor === vscode.window.activeTextEditor) this.track(event.textEditor);
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() === this.state.uri) this.publish();
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.toString() === this.state.uri) this.publish();
      }),
      vscode.extensions.onDidChange(() => {
        this.modeCompatibility = this.readCompatibility();
        if (!this.modeCompatibility.supported && this.document()) this.open();
        this.publish();
      }),
    );
  }

  getPanel(): vscode.WebviewPanel | undefined { return this.panel; }
  getState(): PanelState { return this.state; }
  getPersistedState(): PanelState | undefined { return this.persisted; }
  getSnapshot(): DocumentSnapshot | undefined { return this.snapshot; }
  getCompatibility(): Compatibility { return this.modeCompatibility; }
  /** The answer the panel shows: the last one, if it is about the module
   * the panel follows. */
  getAnswer(): string | null { return this.answer?.uri === this.state.uri ? this.answer.text : null; }
  getVerdictStatus(): { text: string; tooltip: string; visible: boolean } {
    return {
      text: this.verdictItem.text, tooltip: typeof this.verdictItem.tooltip === 'string' ? this.verdictItem.tooltip : '',
      visible: this.verdictUri !== null && this.verdictUri === this.state.uri,
    };
  }
  getLanes(): Array<{ root: string; pid: number | undefined; busy: boolean }> { return this.registry.lanes(); }

  private readCompatibility(): Compatibility {
    return compatibility(vscode.extensions.getExtension(modeId)?.packageJSON.version);
  }

  reportCompatibility(): void {
    if (!this.modeCompatibility.supported && this.document()) this.open();
  }

  open(): void {
    this.track(vscode.window.activeTextEditor, false);
    if (this.panel) {
      this.panel.reveal(undefined, true);
      this.publish();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      viewType, 'Agda Workbench',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { ...panelOptions(this.context.extensionUri), retainContextWhenHidden: false },
    );
    this.attach(panel);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, value: unknown): Promise<void> {
    this.state = restoreState(this.previousPanelState ?? value);
    this.target = undefined;
    if (this.state.uri) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.state.uri));
        if (!isAgda(document)) this.state.uri = null;
      } catch {
        this.error = 'The saved module could not be opened.  Open an Agda module to continue.';
        this.state.uri = null;
      }
    }
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    this.panel = panel;
    this.persisted = undefined;
    panel.webview.options = panelOptions(this.context.extensionUri);
    this.panelSubscriptions.push(
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.clearPanelSubscriptions();
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const input = message as Record<string, unknown>;
        if (input.type === 'ready') this.publish();
        if (input.type === 'persisted') this.persisted = restoreState(input.state);
        if (input.type === 'command' && isAction(input.action)) {
          const action = input.action;
          void (isLaneAction(action) ? this.executeLane(action) : this.execute(action))
            .catch(() => { /* Error displayed by the command. */ });
        }
      }),
      panel.onDidChangeViewState(() => this.publish()),
    );
    panel.webview.html = panelHtml(panel.webview, this.context.extensionUri);
  }

  private track(editor: vscode.TextEditor | undefined, warn = true): void {
    if (editor && isAgda(editor.document)) {
      this.target = editor;
      if (this.state.uri !== editor.document.uri.toString()) this.state.lastCommand = null;
      this.state.uri = editor.document.uri.toString();
      this.error = null;
      this.publish();
      if (warn && !this.modeCompatibility.supported && !this.panel) this.open();
    }
  }

  private document(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(document => document.uri.toString() === this.state.uri);
  }

  private publish(): void {
    // The verdict is shown beside its own module only.
    if (this.verdictUri !== null && this.verdictUri === this.state.uri) this.verdictItem.show();
    else this.verdictItem.hide();
    const document = this.document();
    if (document) {
      this.snapshot = { uri: document.uri.toString(), version: document.version, text: document.getText() };
    } else this.snapshot = undefined;
    if (this.panel) {
      const signature = JSON.stringify(this.state);
      if (signature !== this.stateSignature) {
        this.stateSignature = signature;
        const saved = restoreState(JSON.parse(signature));
        // A hidden webview has no script to call setState.  Persist the host's
        // latest state independently, in the same order as these updates.
        this.stateWrite = this.stateWrite.then(() => this.context.workspaceState.update(stateKey, saved))
          .catch(error => {
            this.error = `The panel state could not be saved: ${String(error)}`;
            this.publish();
          });
      }
    }
    void this.panel?.webview.postMessage({
      type: 'snapshot', state: this.state, busy: this.busy, error: this.error, answer: this.getAnswer(),
      module: document ? vscode.workspace.asRelativePath(document.uri) : null,
      version: document?.version, dirty: document?.isDirty,
      compatibility: this.modeCompatibility,
    });
  }

  private async editor(): Promise<vscode.TextEditor> {
    const active = vscode.window.activeTextEditor;
    if (active && !isAgda(active.document)) throw new Error('The active editor is not an Agda module.');
    const document = active?.document ?? this.document();
    if (!document) throw new Error('Open an Agda module before issuing a command.');
    const previous = this.target?.document === document ? this.target : undefined;
    const selection = previous?.selection;
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: previous?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false, preview: false,
    });
    if (selection) editor.selection = selection;
    this.target = editor;
    this.state.uri = document.uri.toString();
    return editor;
  }

  async execute(action: Action): Promise<DocumentSnapshot> {
    if (isLaneAction(action)) return this.executeLane(action);
    if (this.busy) throw new Error('An Agda Workbench command is already running.');
    this.busy = true;
    this.error = null;
    this.open();
    this.publish();
    try {
      const mode = vscode.extensions.getExtension(modeId);
      if (!mode) throw new Error('Install banacorn.agda-mode to issue Agda commands.');
      await mode.activate();
      const editor = await this.editor();
      const document = editor.document;
      const before = document.getText();
      const started = performance.now();
      let tokenCount: number | undefined;
      if (action === 'highlighting') {
        if (!this.loadRequests.has(document)) {
          throw new Error('Load the module with Agda Workbench before reading highlighting.');
        }
        const tokens = await readTokens(document.uri.toString());
        tokenCount = tokens ? tokens.data.length / 5 : 0;
      } else {
        const command = modeCommands[action];
        if (!(await vscode.commands.getCommands()).includes(command)) {
          throw new Error(`The installed Agda mode does not register ${command}.`);
        }
        await vscode.commands.executeCommand(command);
        if (action === 'load') this.loadRequests.add(document);
      }
      if (this.state.uri === document.uri.toString()) this.state.lastCommand = {
        action, elapsedMs: performance.now() - started,
        documentChanged: before !== document.getText(),
        ...(tokenCount === undefined ? {} : { tokenCount }),
      };
      return { uri: document.uri.toString(), version: document.version, text: document.getText() };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  /** A lane's root and Agda, resolved again on every request, so a change
   * of the settings takes effect at the next command. */
  private async resolveLane(path: string): Promise<LaneConfig | Refusal | Failure> {
    const uri = vscode.Uri.file(path);
    const workbench = vscode.workspace.getConfiguration('agdaWorkbench', uri);
    const mode = vscode.workspace.getConfiguration('agdaMode', uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const project = await findProjectRoot(path, folder);
    // Resolved in the root, where the lanes run, as their spawn would.
    const resolved = await resolveAgda(agdaCandidates({
      workbenchPath: workbench.get('agda.path'), workbenchOptions: workbench.get('agda.commandLineOptions'),
      modePaths: mode.get('connection.paths'), modeOptions: mode.get('connection.commandLineOptions'),
    }), {
      expectedVersion: workbench.get<string>('agda.version') || '2.9.0',
      versionSource: 'agdaWorkbench.agda.version', cache: this.probes, cwd: project.root,
    });
    if ('kind' in resolved) return resolved;
    return { root: project.root, executable: resolved.executable, args: resolved.args };
  }

  private laneEnded(ended: LaneEnded): void {
    if (ended.reason !== 'crashed') return;
    // Told once; the next command starts a new lane.
    const how = ended.detail?.signal ?? (ended.detail?.code !== undefined ? `code ${String(ended.detail.code)}` : 'no word');
    this.error = `The native lane for ${ended.root} stopped (${String(how)}); the next command starts another.`;
    this.publish();
  }

  /** A command of the native lanes, on the active module as it is saved:
   * an expression for infer and normalize is asked for first, before the
   * lane is held. */
  async executeLane(action: LaneAction, argument?: unknown): Promise<LaneResult> {
    if (this.busy) throw new Error('An Agda Workbench command is already running.');
    let expression: string | undefined;
    if (action === 'laneInfer' || action === 'laneNormalize') {
      expression = typeof argument === 'string' ? argument : await vscode.window.showInputBox({
        prompt: action === 'laneInfer' ? 'An expression, to infer its type' : 'An expression, to normalize it',
        ignoreFocusOut: true,
      });
      if (!expression?.trim()) throw new Error('No expression was given.');
    }
    this.busy = true;
    this.error = null;
    this.open();
    this.publish();
    try {
      const editor = await this.editor();
      const document = editor.document;
      if (document.uri.scheme !== 'file') throw new Error('The native lanes read the module from disk; save it to a file first.');
      // The lanes read the saved file, as the mode's own load does.
      if (document.isDirty && !(await document.save())) throw new Error('The module could not be saved, and the native lanes read the saved file.');
      const path = document.uri.fsPath;
      const before = document.getText();
      const version = document.version;
      const offset = document.offsetAt(editor.selection.active);
      const started = performance.now();
      const outcome = action === 'checkFile'
        ? await this.registry.withLane(path, async ({ session, spawned }): Promise<LaneOutcome> => ({
          spawned, result: await createToolSurface(session).check_file({ file: path }),
        }))
        : await this.registry.withFile(path, use => this.laneCommand(action, use, document, { text: before, version, offset, expression, argument }));
      if ('kind' in outcome) throw new Error(outcome.message);
      const elapsedMs = performance.now() - started;
      const result = outcome.result;
      const documentChanged = before !== document.getText();
      const exitCode = result.status === 'verdict' ? result.verdict.exitCode : undefined;
      if (this.state.uri === document.uri.toString()) {
        const report: CommandReport = { action, elapsedMs, documentChanged };
        if (exitCode !== undefined) report.exitCode = exitCode;
        this.state.lastCommand = report;
      }
      // About the module the command ran on, whichever the panel follows now.
      this.answer = { uri: document.uri.toString(), text: describeResult(result) };
      if (result.status === 'verdict') this.showVerdict(document, result.verdict.exitCode, result.elapsedMs);
      const answered: LaneResult = {
        uri: document.uri.toString(), version: document.version, text: document.getText(),
        action, result, spawned: outcome.spawned, elapsedMs, documentChanged,
      };
      if (outcome.load) answered.load = outcome.load;
      if (outcome.loadMs !== undefined) answered.loadMs = outcome.loadMs;
      if (outcome.checking) answered.checking = outcome.checking;
      return answered;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private async laneCommand(
    action: Exclude<LaneAction, 'checkFile'>, use: FileUse, document: vscode.TextDocument,
    asked: { text: string; version: number; offset: number; expression: string | undefined; argument: unknown },
  ): Promise<LaneOutcome> {
    const { session } = use;
    const loaded: Omit<LaneOutcome, 'result'> = {
      spawned: use.spawned, load: use.load,
      ...(use.loaded ? { loadMs: use.loaded.elapsedMs, checking: use.loaded.value.checking } : {}),
    };
    // Agda counts after a byte-order mark, which VS Code's text leaves out.
    const snapshot = session.snapshot ?? '';
    const mark = snapshot.startsWith('\uFEFF') && !asked.text.startsWith('\uFEFF') ? 1 : 0;
    if (snapshot.slice(mark) !== asked.text)
      return { ...loaded, result: refused(action, 'The saved module is not the text in the editor; save it, and run the command again.') };
    const at = asked.offset + mark;
    const goal = session.goals().find(candidate => candidate.span && candidate.span.from <= at && at <= candidate.span.to);
    const tools = createToolSurface(session);
    const scope = goal ? { goal: goal.id } : {};
    switch (action) {
      case 'laneGoal':
        if (!goal) return { ...loaded, result: refused('get_goal', 'Place the cursor inside a goal.') };
        return { ...loaded, result: await tools.get_goal({ goal: goal.id }) };
      case 'laneInfer':
        return { ...loaded, result: await tools.type_of({ expression: asked.expression!, ...scope }) };
      case 'laneNormalize':
        return { ...loaded, result: await tools.normalize({ expression: asked.expression!, ...scope }) };
      case 'laneGive': {
        if (!goal?.span) return { ...loaded, result: refused('give', 'Place the cursor inside a goal.') };
        const braces = snapshot.slice(goal.span.from, goal.span.to);
        const written = braces.startsWith('{!') ? braces.slice(2, -2).trim() : '';
        const term = written || (typeof asked.argument === 'string' ? asked.argument.trim() : '');
        if (!term) return { ...loaded, result: refused('give', 'Write the term in the goal before giving it.') };
        const give = await session.give(session.goalRef(goal.id)!, term);
        if (give.kind !== 'answer')
          return { ...loaded, result: { tool: 'give', status: give.kind === 'refusal' ? 'refused' : 'failed', reason: give.reason, message: give.message } };
        let applied = false;
        const edit = give.value.edit;
        if (give.value.accepted && edit) {
          // Agda's edit is in the text it loaded, which is the editor's
          // unless it changed meanwhile.
          if (document.version === asked.version) {
            const change = new vscode.WorkspaceEdit();
            change.replace(document.uri, new vscode.Range(document.positionAt(edit.from - mark), document.positionAt(edit.to - mark)), edit.insert);
            applied = await vscode.workspace.applyEdit(change) && await document.save();
          }
          if (!applied) session.reloadNext('the editor did not take the give\'s edit');
        }
        return {
          ...loaded,
          result: {
            tool: 'give', status: 'answer', lane: 'interaction', elapsedMs: give.elapsedMs,
            result: {
              goal: goal.id, term, accepted: give.value.accepted, applied,
              ...(give.value.error !== undefined ? { error: give.value.error } : {}),
            },
          },
        };
      }
    }
  }

  private showVerdict(document: vscode.TextDocument, exitCode: number, elapsedMs: number): void {
    this.verdictItem.text = `${exitCode === 0 ? '$(pass)' : '$(error)'} Agda: exit ${exitCode}`;
    this.verdictUri = document.uri.toString();
    this.verdictItem.tooltip = `Batch verdict on ${vscode.workspace.asRelativePath(document.uri)}: exit ${exitCode}, ` +
      `${exitCode === 0 ? 'it checks' : 'it does not check'} (${Math.round(elapsedMs)} ms)`;
  }

  private clearPanelSubscriptions(): void {
    for (const disposable of this.panelSubscriptions.splice(0)) disposable.dispose();
  }

  /** Close every native lane; the registry refuses from then on. */
  shutdown(): Promise<void> {
    this.shuttingDown ??= this.registry.dispose();
    return this.shuttingDown;
  }

  dispose(): void {
    void this.shutdown();
    this.verdictItem.dispose();
    this.panel?.dispose();
    this.clearPanelSubscriptions();
  }
}

let active: Companion | undefined;

export function activate(context: vscode.ExtensionContext): { companion: Companion; activationMs: number } {
  const started = performance.now();
  const companion = new Companion(context);
  active = companion;
  context.subscriptions.push(
    companion,
    vscode.window.registerWebviewPanelSerializer(viewType, companion),
    vscode.commands.registerCommand('agdaWorkbench.open', () => companion.open()),
    ...modeActions.map(action => vscode.commands.registerCommand(`agdaWorkbench.${action}`, () => companion.execute(action))),
    ...laneActions.map(action => vscode.commands.registerCommand(`agdaWorkbench.${action}`,
      (argument?: unknown) => companion.executeLane(action, argument))),
  );
  companion.reportCompatibility();
  return { companion, activationMs: performance.now() - started };
}

/** Every native lane is closed before the extension host lets go. */
export function deactivate(): Promise<void> | undefined {
  return active?.shutdown();
}

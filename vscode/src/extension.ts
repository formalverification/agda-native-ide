// File: vscode/src/extension.ts

import * as vscode from 'vscode';
import { compatibility, Compatibility } from './compatibility';
import { tokenReader } from './highlighting';
import { panelHtml, panelOptions } from './panel';
import { Action, actions, isAction, PanelState, restoreState } from './state';

const viewType = 'agdaWorkbench';
const stateKey = 'agdaWorkbench.panelState';
const modeId = 'banacorn.agda-mode';
const modeCommands: Record<Exclude<Action, 'highlighting'>, string> = {
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

  constructor(private readonly context: vscode.ExtensionContext) {
    // Capture before editor events or a version warning can open a new panel.
    this.previousPanelState = context.workspaceState.get(stateKey);
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
          void this.execute(input.action).catch(() => { /* Error displayed by execute. */ });
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
      type: 'snapshot', state: this.state, busy: this.busy, error: this.error,
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

  private clearPanelSubscriptions(): void {
    for (const disposable of this.panelSubscriptions.splice(0)) disposable.dispose();
  }

  dispose(): void {
    this.panel?.dispose();
    this.clearPanelSubscriptions();
  }
}

export function activate(context: vscode.ExtensionContext): { companion: Companion; activationMs: number } {
  const started = performance.now();
  const companion = new Companion(context);
  context.subscriptions.push(
    companion,
    vscode.window.registerWebviewPanelSerializer(viewType, companion),
    vscode.commands.registerCommand('agdaWorkbench.open', () => companion.open()),
    ...actions.map(action => vscode.commands.registerCommand(`agdaWorkbench.${action}`, () => companion.execute(action))),
  );
  companion.reportCompatibility();
  return { companion, activationMs: performance.now() - started };
}

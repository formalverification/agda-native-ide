// File: vscode/src/test/mode-findings.ts
//
// What decides agda-mode-vscode's Agda, observed in the real extension host
// (issue 99): the run that confirms each finding read from the mode's source
// at v0.10.4.  vscode/scripts/mode-findings.mjs writes the workspace (two
// folders, alpha and beta, each a small library with one goal) and three
// wrapper scripts, w, wb and fallback, each named `agda`, which log every
// call (its time, pid, parent, working directory, PROBE_MARK and arguments)
// and then run the real Agda, behaving as PROBE_BEHAVIOR says.  This runs
// in the same extension host as the mode, so a change to process.env here
// is a change to the environment the mode's next spawn inherits.  Each
// probe records what it saw; the driver adds the mode's workspace state
// and writes the record.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface Call { at: number; pid: number; ppid: number; cwd: string; mark: string; wrapper: string; args: string }

const output = process.env.MODE_FINDINGS_OUTPUT!;
const log = process.env.PROBE_LOG!;
const bin = process.env.PROBE_BIN!;
const wrapper = (name: string) => path.join(bin, name, 'agda');

function calls(): Call[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => {
    const [at, pid, ppid, cwd, mark, name, args] = line.split('\t');
    return { at: Number(at), pid: Number(pid), ppid: Number(ppid), cwd: cwd!, mark: mark!, wrapper: name!, args: args! };
  });
}

/** The calls made while `work` ran, and how long it took. */
async function observe(work: () => Thenable<unknown> | Promise<unknown>): Promise<{ ms: number; calls: Call[]; error?: string }> {
  const before = calls().length;
  const started = Date.now();
  let error: string | undefined;
  try {
    await work();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { ms: Date.now() - started, calls: calls().slice(before).map(call => ({ ...call, at: call.at - started })), ...(error ? { error } : {}) };
}

const folder = (name: string) => vscode.workspace.workspaceFolders!.find(each => each.name === name)!.uri.fsPath;
/** Whether the library's base module was checked by that Agda version:
 * Agda writes its interface under _build/<version>/agda/. */
const built = (name: string, version: string) => existsSync(path.join(folder(name), `_build/${version}/agda/${name[0]!.toUpperCase()}${name.slice(1)}Base.agdai`));
const forget = (name: string) => rmSync(path.join(folder(name), '_build'), { recursive: true, force: true });
const alive = (pid: number) => existsSync(`/proc/${pid}`);

async function show(name: string): Promise<vscode.TextEditor> {
  const file = path.join(folder(name), `${name[0]!.toUpperCase()}${name.slice(1)}.agda`);
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { viewColumn: vscode.ViewColumn.One, preview: false });
}

async function setPaths(paths: string[]): Promise<void> {
  await vscode.workspace.getConfiguration('agdaMode').update('connection.paths', paths, vscode.ConfigurationTarget.Global);
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  const record: Record<string, unknown> = {};
  const mode = vscode.extensions.getExtension('banacorn.agda-mode')!;
  await mode.activate();
  record.host = {
    vscode: vscode.version, mode: mode.packageJSON.version, pid: process.pid, cwd: process.cwd(),
    folders: vscode.workspace.workspaceFolders!.map(each => each.uri.fsPath),
  };
  const agdaVersion = process.env.PROBE_AGDA_VERSION!;
  try {
    // 1.  Where and with what the mode spawns Agda: the extension host's
    //     working directory and environment, as they are at the spawn.
    await setPaths([wrapper('w')]);
    process.env.PROBE_MARK = 'set-after-activation';
    await show('alpha');
    const first = await observe(() => vscode.commands.executeCommand('agda-mode.load'));
    record.spawn = { ...first, alphaBuilt: built('alpha', agdaVersion) };

    // 2.  One connection per window, and the settings it reads: a load in
    //     the other folder reuses the running Agda; a folder's own
    //     agdaMode.connection.paths (beta's names wb) is what VS Code gives
    //     for a resource in it, and is not what the mode runs.
    await show('beta');
    const reuse = await observe(() => vscode.commands.executeCommand('agda-mode.load'));
    const betaUri = vscode.Uri.file(folder('beta'));
    record.oneConnection = { ...reuse, betaBuilt: built('beta', agdaVersion) };
    // 3.  Restart: kills the running Agda and loads the active file again
    //     with a new spawn, which reads the environment as it is then.
    const oldPid = first.calls.find(call => call.args.startsWith('--interaction'))?.pid ?? 0;
    forget('beta');
    process.env.PROBE_MARK = 'set-before-restart';
    const restart = await observe(() => vscode.commands.executeCommand('agda-mode.restart'));
    record.folderSetting = {
      forTheFolder: vscode.workspace.getConfiguration('agdaMode', betaUri).get('connection.paths'),
      forTheWindow: vscode.workspace.getConfiguration('agdaMode').get('connection.paths'),
      ranAfterRestart: [...new Set(restart.calls.map(call => call.wrapper))],
    };
    record.restart = { ...restart, oldPid, oldPidAlive: alive(oldPid), betaLoadedAgain: built('beta', agdaVersion) };

    // 4.  The probe: `--version`, with a 3 s timeout that the first output
    //     on either stream clears.  A silent wrapper is passed over for the
    //     next entry (fallback, the earlier one in the list); one that says
    //     something on stderr first is waited for; stdout around Agda's
    //     version line is tolerated; stderr when the interaction starts is
    //     taken as an error of Agda's; exit 69 is passed over like silence.
    await setPaths([wrapper('fallback'), wrapper('w')]);
    process.env.PROBE_TARGET = 'w';
    const probe = async (behavior: string, delay = '5') => {
      process.env.PROBE_BEHAVIOR = behavior;
      process.env.PROBE_DELAY = delay;
      forget('beta');
      const seen = await observe(() => vscode.commands.executeCommand('agda-mode.restart'));
      delete process.env.PROBE_BEHAVIOR;
      return {
        ...seen, betaBuilt: built('beta', agdaVersion),
        interaction: seen.calls.filter(call => call.args.startsWith('--interaction')).map(call => call.wrapper),
      };
    };
    record.probe = {
      silent: await probe('silent'),
      noisy: await probe('noisy', '8'),
      stdoutAroundVersion: await probe('stdout-junk'),
      stderrAtStart: await probe('noisy-start'),
      refuse: await probe('refuse'),
    };
    await setPaths([wrapper('w')]);
    record.refuseAlone = await probe('refuse');

    // 5.  switch-agda-version: a quick pick of agdaMode.connection.paths,
    //     last first, then downloads.  Pick the second candidate (fallback)
    //     and see what is written: the driver compares the settings files
    //     and reads the mode's workspace state afterward.
    await setPaths([wrapper('fallback'), wrapper('w')]);
    await vscode.commands.executeCommand('agda-mode.restart');
    void vscode.commands.executeCommand('agda-mode.switch-agda-version');
    await pause(3000);
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await pause(500);
    // The switch connects to the pick to test it, then closes that
    // connection; wait for its interaction and a little more.
    const picked = await observe(async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const before = calls().length;
      for (let waited = 0; waited < 15000 && !calls().slice(before).some(call => call.args.startsWith('--interaction')); waited += 100) await pause(100);
      await pause(2000);
    });
    forget('beta');
    await show('beta');
    const after = await observe(() => vscode.commands.executeCommand('agda-mode.load'));
    record.switchVersion = {
      picked, after, pathsAfter: vscode.workspace.getConfiguration('agdaMode').get('connection.paths'),
      ranAfter: [...new Set(after.calls.map(call => call.wrapper))],
    };
  } catch (error) {
    record.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }
  await writeFile(output, JSON.stringify(record, null, 2) + '\n');
}

// File: vscode/src/test/desktop.ts
//
// The desktop run of issue 99: real projects on two Agdas in one window,
// written by scripts/desktop-run.mjs (agda-algebras on Agda 2.9.0 and
// formal-ledger-specifications on 2.8.0, by default).  agda-mode-vscode
// names agda-for-project as its one path, set before the window opens,
// and no setting changes afterward.  For each project in turn, and then
// the first again, it opens the file, waits for the companion to find (and
// if need be build) its Agda, loads it with agda-mode.load (what C-c C-l
// runs), times the load, asks the mode's running Agda its version, and
// takes a screenshot of the display.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findProjectRoot } from '@agda-native-ide/engine/native';
import type { Companion } from '../extension';
import { listProcesses, modeAgda } from '../project';

interface Project { name: string; folder: string; file: string; version: string }

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  const output = process.env.DESKTOP_OUTPUT!;
  const projects = JSON.parse(process.env.DESKTOP_PROJECTS!) as Project[];
  const userSettings = process.env.DESKTOP_USER_SETTINGS!;
  const settingsBefore = readFileSync(userSettings, 'utf8');
  const companion = (await vscode.extensions.getExtension<{ companion: Companion }>('formalverification.agda-native-ide')!.activate()).companion;
  const steering = companion.steering;
  /** A screenshot of the display, when ImageMagick's import can take one. */
  const shot = (name: string) => {
    const file = path.join(output, `${name}.png`);
    try {
      execFileSync(process.env.DESKTOP_IMPORT!, ['-window', 'root', file]);
      return path.basename(file);
    } catch {
      return null;
    }
  };
  // The screenshots show the editor, the mode's panel and the status bar.
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const steps: unknown[] = [];
  for (const project of [...projects, projects[0]!]) {
    const index = steps.length + 1;
    const restartsBefore = steering.restarts.length;
    const opened = performance.now();
    const document = await vscode.workspace.openTextDocument(path.join(project.folder, project.file));
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    const root = (await findProjectRoot(document.uri.fsPath)).root;
    while (steering.getFollowed()?.root !== root || (!steering.getFollowed()?.answer && !steering.getFollowed()?.error)) await pause(100);
    await steering.idle();
    const followedMs = Math.round(performance.now() - opened);
    const followed = steering.getFollowed()!;
    assert.ok(followed.answer?.decided, `${project.name}: ${followed.error ?? 'undecided'}`);
    const restarted = steering.restarts.length - restartsBefore;
    const started = performance.now();
    await vscode.commands.executeCommand('agda-mode.load');
    const loadMs = Math.round(performance.now() - started);
    await pause(1500);
    const mode = modeAgda(await listProcesses(), process.pid);
    assert.ok(mode, 'the mode runs an Agda');
    const running = execFileSync(mode.args.split(' ')[0]!, ['--numeric-version'], { encoding: 'utf8' }).trim();
    assert.equal(running, project.version, `${project.name} under Agda ${project.version}`);
    steps.push({
      project: project.name, file: project.file, status: steering.getStatus().text,
      decidedBy: followed.answer!.decidedBy, method: followed.answer!.method, name: followed.answer!.name,
      program: followed.answer!.program, args: followed.answer!.args,
      followedMs, explainMs: followed.explainMs, restarted,
      restartMs: restarted ? steering.restarts.at(-1)?.ms : undefined,
      loadMs, modeAgda: mode.args.split(' ')[0], modeVersion: running,
      screenshot: shot(`${index}-${project.name}`),
    });
  }
  const settingsAfter = readFileSync(userSettings, 'utf8');
  assert.equal(settingsAfter, settingsBefore, 'no setting changed');
  await writeFile(path.join(output, 'desktop-run.json'), JSON.stringify({
    steps, restarts: steering.restarts.length, settingsUnchanged: settingsAfter === settingsBefore,
    vscode: vscode.version, mode: vscode.extensions.getExtension('banacorn.agda-mode')!.packageJSON.version,
  }, null, 2) + '\n');
}

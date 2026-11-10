// File: vscode/scripts/desktop-run.mjs
//
// Issue 99's desktop run, for the website (issue 96): agda-algebras and
// formal-ledger-specifications open in one VS Code window, with the
// pinned agda-mode-vscode naming agda-for-project as its one path (set
// before the window opens; nothing changes after), and a file of each
// loaded with agda-mode.load, what C-c C-l runs, under its own Agda.  It
// runs src/test/desktop.ts in a private profile under Xvfb, keeps the
// launcher's choices in its own temporary tree (its cache is the user's,
// ~/.cache/agda-for-project, beside Nix's own, which a cold copy would
// fetch and evaluate again), and writes desktop-run.json and a screenshot
// per load into --out.
//
//   nix develop .#vscode --command node vscode/scripts/desktop-run.mjs \
//     --out DIR [--tmp DIR] [--import PATH-TO-IMAGEMAGICK-IMPORT]
//
// The checkouts default to ~/git/ualib/agda-algebras/master and
// ~/git/IO/fls/master; DESKTOP_AGDA_ALGEBRAS and DESKTOP_FLS override them.
// Agda writes its interfaces into their _build directories, as any load
// does; nothing else in them is written.

import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const { values: options } = parseArgs({ options: { out: { type: 'string' }, tmp: { type: 'string' }, import: { type: 'string' } } });
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(options.out ?? path.join(extensionRoot, 'test-output/desktop-run'));
const launcher = process.env.AGDA_FOR_PROJECT;
if (!launcher) throw new Error('Set AGDA_FOR_PROJECT (nix develop .#vscode sets it).');
const importer = options.import ?? 'import';
const projects = [
  { name: 'agda-algebras', folder: process.env.DESKTOP_AGDA_ALGEBRAS ?? path.join(os.homedir(), 'git/ualib/agda-algebras/master'), file: 'src/Overture/Basic.lagda.md', version: '2.9.0' },
  { name: 'formal-ledger-specifications', folder: process.env.DESKTOP_FLS ?? path.join(os.homedir(), 'git/IO/fls/master'), file: 'src/Interface/STS.lagda.md', version: '2.8.0' },
];

await mkdir(options.tmp ?? os.tmpdir(), { recursive: true });
const temporary = await mkdtemp(path.join(options.tmp ?? os.tmpdir(), 'desktop-run-'));
await mkdir(out, { recursive: true });
const quiet = {
  'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off',
  'update.mode': 'none', 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
  'agdaMode.connection.downloadPolicy': "No, and don't ask again",
};
const workspaceFile = path.join(temporary, 'desktop.code-workspace');
await writeFile(workspaceFile, JSON.stringify({ folders: projects.map(project => ({ name: project.name, path: project.folder })), settings: {} }, null, 2));
const userSettings = path.join(temporary, 'user/User/settings.json');
await mkdir(path.dirname(userSettings), { recursive: true });
await writeFile(userSettings, JSON.stringify({ ...quiet, 'agdaMode.connection.paths': [launcher] }, null, 2));

const executable = process.env.VSCODE_EXECUTABLE ?? await downloadAndUnzipVSCode({ version: '1.141.0', cachePath: path.join(extensionRoot, '.vscode-test') });
const extensions = path.join(temporary, 'extensions');
await mkdir(extensions);
if (process.env.AGDA_MODE_EXTENSION) {
  await cp(process.env.AGDA_MODE_EXTENSION, path.join(extensions, 'banacorn.agda-mode-0.10.4'), { recursive: true });
} else {
  const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(cli, [...args, `--extensions-dir=${extensions}`, `--user-data-dir=${temporary}/install-user`,
    '--install-extension', 'banacorn.agda-mode@0.10.4', '--force'], { stdio: 'inherit' });
}

const display = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'inherit'] });
process.env.DISPLAY = await new Promise((resolve, reject) => {
  display.once('error', reject);
  display.stdout.once('data', data => resolve(`:${String(data).trim()}`));
});
const started = Date.now();
try {
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'out/test/desktop.js'),
    extensionTestsEnv: {
      DESKTOP_OUTPUT: out, DESKTOP_PROJECTS: JSON.stringify(projects), DESKTOP_USER_SETTINGS: userSettings, DESKTOP_IMPORT: importer,
      XDG_STATE_HOME: path.join(temporary, 'state'),
    },
    launchArgs: [workspaceFile, `--extensions-dir=${extensions}`, `--user-data-dir=${path.join(temporary, 'user')}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
  });
} finally {
  display.kill();
}
const checkout = folder => execFileSync('git', ['-C', folder, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim();
await writeFile(path.join(out, 'run.json'), JSON.stringify({
  date: new Date().toISOString(), machine: `${os.hostname()} ${os.platform()} ${os.release()} ${os.cpus()[0]?.model}`,
  wallMs: Date.now() - started, launcher, checkouts: Object.fromEntries(projects.map(project => [project.name, checkout(project.folder)])),
}, null, 2) + '\n');
console.log(`desktop run: ${out}`);

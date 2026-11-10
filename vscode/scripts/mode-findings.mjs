// File: vscode/scripts/mode-findings.mjs
//
// The extension-host run behind issue 99's findings about agda-mode-vscode:
// what decides its Agda.  It writes a multi-root workspace of two small
// libraries (alpha and beta, each one module with a goal), three wrapper
// scripts named `agda` (w, wb and fallback) that log each call and then run
// the real Agda as PROBE_BEHAVIOR says, and beta's own folder setting
// naming wb; runs src/test/mode-findings.ts in the pinned VS Code with the
// pinned mode, in a private profile; and then adds whether any settings
// file changed.  The record
// goes to --out (default vscode/test-output/mode-findings.json).
//
//   nix develop .#vscode --command node vscode/scripts/mode-findings.mjs [--out FILE]

import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const { values: options } = parseArgs({ options: { out: { type: 'string' }, tmp: { type: 'string' } } });
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(options.out ?? path.join(extensionRoot, 'test-output/mode-findings.json'));
const vscodeVersion = '1.141.0';
const modeVersion = '0.10.4';
const agda = process.env.AGDA ?? 'agda';
const agdaVersion = execFileSync(agda, ['--numeric-version'], { encoding: 'utf8' }).trim();

// --tmp keeps the run's tree (the mode's workspace state is read from it)
// out of nix develop's temporary directory, which is removed at its exit.
await mkdir(options.tmp ?? os.tmpdir(), { recursive: true });
const temporary = await mkdtemp(path.join(options.tmp ?? os.tmpdir(), 'mode-findings-'));
const bin = path.join(temporary, 'bin');
const log = path.join(temporary, 'calls.log');
// Each wrapper logs, and runs the real Agda with every argument; the one
// PROBE_TARGET names (w, in every probe) first behaves as PROBE_BEHAVIOR
// says: silent (a 3 s probe would time out), noisy
// (says something on stderr first, then waits), stdout-junk (a line of its
// own around Agda's version), noisy-start (stderr as the interaction
// starts), refuse (one line on stderr and exit 69, as agda-for-project).
const script = name => `#!/usr/bin/env bash
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(date +%s%3N)" "$$" "$PPID" "$(pwd -P)" "\${PROBE_MARK:-}" ${name} "$*" >> ${JSON.stringify(log)}
[ "\${PROBE_TARGET:-}" = ${name} ] || PROBE_BEHAVIOR=
case "\${PROBE_BEHAVIOR:-}" in
  silent) if [ "$1" = --version ]; then sleep "\${PROBE_DELAY:-5}"; fi ;;
  noisy) if [ "$1" = --version ]; then echo "probe: building (simulated)" >&2; sleep "\${PROBE_DELAY:-5}"; fi ;;
  stdout-junk) if [ "$1" = --version ]; then echo "probe: a line of the wrapper's own"; fi ;;
  noisy-start) if [ "$1" = --interaction ]; then echo "probe: building at start (simulated)" >&2; sleep 1; fi ;;
  refuse) echo "agda-for-project: no Agda for this project (simulated)" >&2; exit 69 ;;
esac
exec ${JSON.stringify(agda)} "$@"
`;
for (const name of ['w', 'wb', 'fallback']) {
  await mkdir(path.join(bin, name), { recursive: true });
  await writeFile(path.join(bin, name, 'agda'), script(name));
  await chmod(path.join(bin, name, 'agda'), 0o755);
}

const workspace = path.join(temporary, 'workspace');
// Agda writes no interface for a module with an open goal, so each
// library's module imports a base without one: the base's interface, in
// _build/<version>/agda/, names the Agda that checked it.
const base = name => `module ${name}Base where\n\ndata N : Set where\n  z : N\n  s : N → N\n`;
const module = name => `module ${name} where\n\nopen import ${name}Base\n\nx : N\nx = {! !}\n`;
for (const name of ['alpha', 'beta']) {
  const Name = name[0].toUpperCase() + name.slice(1);
  await mkdir(path.join(workspace, name, '.vscode'), { recursive: true });
  await writeFile(path.join(workspace, name, `${name}.agda-lib`), `name: ${name}\ninclude: .\n`);
  await writeFile(path.join(workspace, name, `${Name}Base.agda`), base(Name));
  await writeFile(path.join(workspace, name, `${Name}.agda`), module(Name));
}
const betaSettings = JSON.stringify({ 'agdaMode.connection.paths': [path.join(bin, 'wb', 'agda')] }, null, 2);
await writeFile(path.join(workspace, 'beta/.vscode/settings.json'), betaSettings);
const workspaceFile = path.join(workspace, 'probe.code-workspace');
const workspaceSettings = {
  'agdaMode.connection.downloadPolicy': "No, and don't ask again",
  'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
};
await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: 'alpha' }, { path: 'beta' }], settings: workspaceSettings }, null, 2));
const user = path.join(temporary, 'user');
await mkdir(path.join(user, 'User'), { recursive: true });
await writeFile(path.join(user, 'User/settings.json'), JSON.stringify(workspaceSettings));
const agdaDir = path.join(temporary, 'agda-dir');
await mkdir(agdaDir);

const executable = process.env.VSCODE_EXECUTABLE ?? await downloadAndUnzipVSCode({
  version: vscodeVersion, cachePath: path.join(extensionRoot, '.vscode-test'),
});
const extensions = path.join(temporary, 'extensions');
await mkdir(extensions);
if (process.env.AGDA_MODE_EXTENSION) {
  await cp(process.env.AGDA_MODE_EXTENSION, path.join(extensions, `banacorn.agda-mode-${modeVersion}`), { recursive: true });
} else {
  const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(cli, [...args, `--extensions-dir=${extensions}`, `--user-data-dir=${temporary}/install-user`,
    '--install-extension', `banacorn.agda-mode@${modeVersion}`, '--force'], { stdio: 'inherit' });
}

let display;
if (!process.env.DISPLAY) {
  display = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.env.DISPLAY = await new Promise((resolve, reject) => {
    display.once('error', reject);
    display.stdout.once('data', data => resolve(`:${String(data).trim()}`));
  });
}
const result = path.join(temporary, 'result.json');
try {
  await runTests({
    vscodeExecutablePath: executable,
    // A development path is required; the companion is loaded beside the
    // mode but nothing here calls it.
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'out/test/mode-findings.js'),
    extensionTestsEnv: {
      MODE_FINDINGS_OUTPUT: result, PROBE_LOG: log, PROBE_BIN: bin, PROBE_AGDA_VERSION: agdaVersion, AGDA_DIR: agdaDir,
    },
    launchArgs: [workspaceFile, `--extensions-dir=${extensions}`, `--user-data-dir=${user}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
  });
} finally {
  display?.kill();
}

const record = JSON.parse(await readFile(result, 'utf8'));
// Where switch-agda-version wrote its choice: no settings file changed.
// The source keeps it in the mode's workspace state (Memento.res, key
// preferredCandidate, over ExtensionContext.workspaceState in Main.res),
// which the test host exits before VS Code writes to disk, so it is seen
// here only by its effect: the next connection runs the pick, not the last
// entry of agdaMode.connection.paths.
record.switchVersion = {
  ...record.switchVersion,
  userSettings: JSON.parse(await readFile(path.join(user, 'User/settings.json'), 'utf8'))['agdaMode.connection.paths'] ?? null,
  workspaceFileSettingsUnchanged: JSON.stringify(JSON.parse(await readFile(workspaceFile, 'utf8')).settings) === JSON.stringify(workspaceSettings),
  betaFolderSettingsUnchanged: (await readFile(path.join(workspace, 'beta/.vscode/settings.json'), 'utf8')) === betaSettings,
};
record.run = {
  date: new Date().toISOString(), machine: `${os.hostname()} ${os.platform()} ${os.release()} ${os.cpus()[0]?.model}`,
  vscode: vscodeVersion, mode: modeVersion, agda: agdaVersion, temporary,
};
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(record, null, 2) + '\n');
console.log(`mode findings: ${out}`);

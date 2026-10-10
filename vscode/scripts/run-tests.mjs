// File: vscode/scripts/run-tests.mjs

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

if (process.platform !== 'linux') {
  throw new Error('The companion integration tests require Linux with Xvfb and xdotool.');
}

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(extensionRoot, 'test-output');
const vscodeVersion = '1.141.0';
const modeVersion = '0.10.4';
const sourceRoot = process.env.AGDA_ALGEBRAS ?? path.join(os.homedir(), 'git/ualib/agda-algebras/master');
const agda = process.env.AGDA ?? 'agda';
const source = await readFile(path.join(sourceRoot, 'src/Overture/Basic.lagda.md'), 'utf8');
const blocks = Array.from(source.matchAll(/^```agda\n([\s\S]*?)^```/gm), match => match[1]);
if (!blocks.length || !blocks.join('\n').includes('ℓ₁ = suc 0ℓ')) throw new Error('The copied Overture.Basic fixture has changed.');
const sourceHash = createHash('sha256').update(source).digest('hex');
const nativeVersion = execFileSync(agda, ['--numeric-version'], { encoding: 'utf8' }).trim();
if (nativeVersion !== '2.9.0') throw new Error(`Tests require native Agda 2.9.0; found ${nativeVersion}.  Set AGDA to the project's executable.`);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'agda-companion-'));
const stdlib = path.join(temporary, 'stdlib');
await mkdir(stdlib);
execFileSync('unzip', ['-q', process.env.AGDA_STDLIB_ZIP ?? path.join(extensionRoot, '../static/agda-stdlib-2.3-patched.zip'), '-d', stdlib]);
const executable = process.env.VSCODE_EXECUTABLE ?? await downloadAndUnzipVSCode({
  version: vscodeVersion, cachePath: path.join(extensionRoot, '.vscode-test'),
});
let display;
if (process.platform === 'linux' && !process.env.DISPLAY) {
  // Let Xvfb choose an unused display; do not disturb the user's X server.
  display = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'pipe'] });
  display.stderr.on('data', data => process.stderr.write(data));
  process.env.DISPLAY = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { display.kill(); reject(new Error('Xvfb did not allocate a display')); }, 10000);
    display.once('error', error => { clearTimeout(timer); reject(error); });
    display.stdout.once('data', data => { clearTimeout(timer); resolve(`:${String(data).trim()}`); });
    display.once('exit', code => { clearTimeout(timer); reject(new Error(`Xvfb exited: ${code}`)); });
  });
}

try {
  const installed = path.join(temporary, 'mode');
  await mkdir(installed);
  if (process.env.AGDA_MODE_EXTENSION) {
    await cp(process.env.AGDA_MODE_EXTENSION, path.join(installed, `banacorn.agda-mode-${modeVersion}`), { recursive: true });
  } else {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);
    execFileSync(cli, [...args, `--extensions-dir=${installed}`, `--user-data-dir=${temporary}/install-user`, '--install-extension', `banacorn.agda-mode@${modeVersion}`, '--force'], { stdio: 'inherit' });
  }
  const { readdir } = await import('node:fs/promises');
  const modeDirectory = (await readdir(installed)).find(name => name.startsWith('banacorn.agda-mode-'));
  if (!modeDirectory) throw new Error('The pinned Agda mode was not installed.');
  const manifest = JSON.parse(await readFile(path.join(installed, modeDirectory, 'package.json'), 'utf8'));
  if (manifest.version !== modeVersion) throw new Error(`Expected Agda mode ${modeVersion}; found ${manifest.version}`);
  const modeBundleHash = createHash('sha256').update(await readFile(path.join(installed, modeDirectory, manifest.main))).digest('hex');
  for (const testCase of ['supported', 'mismatch']) {
    const root = path.join(temporary, testCase);
    const workspace = path.join(root, 'workspace');
    const extensions = path.join(root, 'extensions');
    const caseOutput = path.join(root, 'output');
    await mkdir(path.join(workspace, 'Overture'), { recursive: true });
    await mkdir(path.join(workspace, '.vscode'));
    await mkdir(caseOutput, { recursive: true });
    await mkdir(path.join(root, 'user/User'), { recursive: true });
    await writeFile(path.join(root, 'user/User/settings.json'), JSON.stringify({
      'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
      'workbench.startupEditor': 'none', 'window.restoreWindows': 'all',
    }));
    await cp(installed, extensions, { recursive: true });
    if (testCase === 'mismatch') {
      const altered = { ...manifest, version: '999.0.0' };
      await writeFile(path.join(extensions, modeDirectory, 'package.json'), JSON.stringify(altered));
    }
    // Keep the original outside Agda's include root; two files declaring
    // Overture.Basic would make the load ambiguous.
    await mkdir(path.join(root, 'original/Overture'), { recursive: true });
    await writeFile(path.join(root, 'original/Overture/Basic.lagda.md'), source);
    await writeFile(path.join(workspace, 'Overture/Basic.agda'), blocks.join('\n').replace('ℓ₁ = suc 0ℓ', 'ℓ₁ = {! suc 0ℓ !}'));
    await writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
      'agdaMode.connection.paths': [agda],
      'agdaMode.connection.commandLineOptions': `--no-libraries --no-default-libraries -i ${stdlib}/agda-stdlib-2.3/src -i ${workspace}`,
      'agdaMode.connection.downloadPolicy': "No, and don't ask again",
      'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
      'workbench.startupEditor': 'none', 'window.restoreWindows': 'all',
    }));
    const options = {
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: path.join(extensionRoot, 'out/test/host.js'),
      extensionTestsEnv: { COMPANION_TEST_OUTPUT: caseOutput, COMPANION_TEST_CASE: testCase },
      launchArgs: [workspace, `--extensions-dir=${extensions}`, `--user-data-dir=${root}/user`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
    };
    await runTests(options);
    if (testCase === 'supported') {
      const driver = path.join(root, 'reload-driver');
      await mkdir(driver);
      await writeFile(path.join(driver, 'package.json'), JSON.stringify({
        name: 'companion-reload-test', publisher: 'formalverification', version: '0.0.1',
        engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './index.cjs',
        extensionDependencies: ['formalverification.agda-native-ide'],
      }));
      await writeFile(path.join(driver, 'index.cjs'), `exports.activate = require(${JSON.stringify(path.join(extensionRoot, 'out/test/reload.js'))}).activate;\n`);
      for (const reloadCase of ['visible', 'hidden']) {
        const child = spawn(executable, [workspace, `--extensionDevelopmentPath=${extensionRoot}`, `--extensionDevelopmentPath=${driver}`,
          `--extensions-dir=${extensions}`, `--user-data-dir=${root}/reload-user-${reloadCase}`, '--disable-workspace-trust',
          '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
          { stdio: 'inherit', env: { ...process.env, COMPANION_TEST_OUTPUT: caseOutput, COMPANION_RELOAD_CASE: reloadCase } });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('Window reload test timed out')); }, 90000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Reload window exited: ${code}`)); });
        });
        const reload = JSON.parse(await readFile(path.join(caseOutput, `reload-result-${reloadCase}.json`), 'utf8'));
        if (!reload.restored) throw new Error(reload.error);
      }
    }
    const report = JSON.parse(await readFile(path.join(caseOutput, `${testCase}.json`), 'utf8'));
    delete report.modeRoot;
    report.reloadRestored = testCase === 'supported';
    report.hiddenStateRestored = testCase === 'supported';
    report.agda = nativeVersion;
    report.sourceSha256 = sourceHash;
    report.modeBundleSha256 = modeBundleHash;
    await writeFile(path.join(output, `${testCase}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`Companion reports: ${output}`);
} finally {
  display?.kill();
}

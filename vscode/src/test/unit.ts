// File: vscode/src/test/unit.ts

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeResult } from '../answers';
import { compatibility } from '../compatibility';
import { tokenReader } from '../highlighting';
import { agdaCandidates, isLanguageServer, splitOptions } from '../resolution';
import {
  candidates, choose, explain, lastLine, laneVersionRefusal, libraryDepends, modeAgda, modeLauncher, parsePs,
  runKey, starterFlake, type Explained, type Ran,
} from '../project';
import { restoreState } from '../state';

test('the version list is exact, and unknown manifests remain unsupported', () => {
  assert.equal(compatibility('0.10.4').supported, true);
  for (const version of ['0.10.5', '0.10.40', '0.10.4-preview', '', null, 10]) {
    const status = compatibility(version);
    assert.equal(status.supported, false);
    assert.match(status.message, /Found agda-mode-vscode/);
    assert.match(status.message, /Tested versions: 0\.10\.4/);
  }
});

test('timed-out highlighting retries share one request until it settles', async () => {
  let calls = 0;
  let finish!: (value: number) => void;
  const read = tokenReader(() => {
    calls++;
    return new Promise<number>(resolve => { finish = resolve; });
  }, 10);
  const first = read('file:///a.agda');
  await assert.rejects(first, /Highlighting is still pending/);
  for (let retry = 0; retry < 5; retry++) {
    assert.equal(read('file:///a.agda'), first);
    await assert.rejects(read('file:///a.agda'), /Highlighting is still pending/);
  }
  assert.equal(calls, 1);
  finish(4);
  await new Promise(resolve => setImmediate(resolve));
  const fresh = read('file:///a.agda');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish(5);
  assert.equal(await fresh, 5);
});

test('highlighting requests are independent by URI and retry after rejection', async () => {
  const calls: string[] = [];
  const read = tokenReader(async uri => {
    calls.push(uri);
    if (calls.length === 1) throw new Error('provider failed');
    return uri;
  });
  await assert.rejects(read('file:///a.agda'), /provider failed/);
  assert.deepEqual(await Promise.all([read('file:///a.agda'), read('file:///b.agda')]),
    ['file:///a.agda', 'file:///b.agda']);
  assert.deepEqual(calls, ['file:///a.agda', 'file:///a.agda', 'file:///b.agda']);
});

test('restoration ignores malformed, future and executable command state', () => {
  const empty = { schema: 1, uri: null, lastCommand: null };
  for (const value of [null, 4, 'state', {}, { schema: 2, uri: 'file:///x.agda' }]) {
    assert.deepEqual(restoreState(value), empty);
  }
  const good = { schema: 1, uri: 'file:///x.agda', lastCommand: { action: 'give', elapsedMs: 3, documentChanged: true } };
  assert.deepEqual(restoreState(good), good);
  for (const patch of [{ action: 'workbench.action.quit' }, { elapsedMs: NaN },
    { elapsedMs: Infinity }, { elapsedMs: -1 }, { documentChanged: 'yes' }]) {
    assert.equal(restoreState({ ...good, lastCommand: { ...good.lastCommand, ...patch } }).lastCommand, null);
  }
  assert.equal(restoreState({ schema: 1, uri: 'x'.repeat(8193) }).uri, null);
  assert.deepEqual(restoreState({ ...good, text: 'stale source', lastCommand: { ...good.lastCommand, tokenCount: -1 } }), good);
});

test('the companion\'s own Agda setting wins, with its own options, and nothing else is tried', () => {
  assert.deepEqual(agdaCandidates({
    workbenchPath: ' /opt/agda/bin/agda ', workbenchOptions: '--without-K  -i src',
    modePaths: ['agda'], modeOptions: '--safe',
  }), [{
    source: 'agdaWorkbench.agda.path', executable: '/opt/agda/bin/agda',
    args: ['--without-K', '-i', 'src'], argsSource: 'agdaWorkbench.agda.commandLineOptions',
  }]);
});

test('the mode\'s paths are tried from the last, passing over language servers, and then PATH, with the mode\'s options', () => {
  const modeOptions = '--no-libraries -i /w';
  const candidates = agdaCandidates({
    workbenchPath: '', modeOptions,
    modePaths: ['agda', '/nix/store/x/bin/agda', 'als', '/home/u/.config/Code/als-v2.9.0', 'lsp://localhost:4096', 3],
  });
  const args = ['--no-libraries', '-i', '/w'];
  const argsSource = 'agdaMode.connection.commandLineOptions';
  assert.deepEqual(candidates, [
    { source: 'agdaMode.connection.paths', executable: '/nix/store/x/bin/agda', args, argsSource },
    { source: 'agdaMode.connection.paths', executable: 'agda', args, argsSource },
    { source: 'PATH', executable: 'agda', args, argsSource },
  ]);
  assert.deepEqual(agdaCandidates({}), [{ source: 'PATH', executable: 'agda', args: [], argsSource }]);
  for (const server of ['als', 'als.exe', '/x/agda-language-server', 'ws://host:1', 'lsp://h:4096'])
    assert.equal(isLanguageServer(server), true, server);
  for (const agda of ['agda', '/x/agda-2.9.0', '/x/.agda/bin/agda']) assert.equal(isLanguageServer(agda), false, agda);
});

test('options are split as agda-mode-vscode splits them, on single spaces', () => {
  assert.deepEqual(splitOptions('  --safe   --without-K '), ['--safe', '--without-K']);
  assert.deepEqual(splitOptions(''), []);
  assert.deepEqual(splitOptions(['--safe']), []);
});

test('a verdict\'s exit code is restored only for a verdict, and only as an integer', () => {
  const verdict = { schema: 1, uri: 'file:///x.agda', lastCommand: { action: 'checkFile', elapsedMs: 9, documentChanged: false, exitCode: 42 } };
  assert.deepEqual(restoreState(verdict), verdict);
  assert.equal(restoreState({ ...verdict, lastCommand: { ...verdict.lastCommand, exitCode: 4.2 } }).lastCommand?.exitCode, undefined);
  assert.equal(restoreState({ ...verdict, lastCommand: { ...verdict.lastCommand, action: 'load' } }).lastCommand?.exitCode, undefined);
});

test('the panel says what the lanes answered', () => {
  assert.equal(describeResult({
    tool: 'get_goal', status: 'answer', lane: 'interaction', elapsedMs: 2,
    tree: { engine: 'native', session: 's', agdaVersion: '2.9.0', file: '/w/M.agda', digest: 'sha256:0', generation: 1 },
    result: { goal: 0, type: 'Level', context: [{ name: 'x', originalName: 'x', type: 'A', inScope: false }] },
  }), 'Goal 0: Level\n\nContext:\n  x : A  (not in scope)');
  assert.equal(describeResult({
    tool: 'check_file', status: 'verdict', lane: 'batch', elapsedMs: 900,
    tree: { engine: 'native', agdaVersion: '2.9.0', file: '/w/M.agda', digest: 'sha256:0' },
    command: { executable: 'agda', args: ['/w/M.agda'], cwd: '/w' },
    verdict: { exitCode: 42, equivalentTo: 'cd /w && agda /w/M.agda', meaning: '' },
    result: { success: false, diagnostics: [{ severity: 'error', code: 'UnsolvedInteractionMetas', range: { startLine: 3, startCol: 5, endLine: 3, endCol: 9 }, message: 'Unsolved interaction metas' }] },
  }), 'Batch verdict: exit 42, the module does not check.\nUnsolvedInteractionMetas at line 3, column 5:\nUnsolved interaction metas');
  assert.equal(describeResult({
    tool: 'give', status: 'answer', lane: 'interaction', elapsedMs: 3,
    result: { goal: 1, term: 'zero', accepted: false, error: 'Nat !=< A', applied: false },
  }), 'Agda refused zero for goal 1: Nat !=< A');
  assert.equal(describeResult({ tool: 'type_of', status: 'refused', reason: 'configuration', message: 'no Agda was found' }), 'no Agda was found');
});

const answer = (fields: Partial<Explained>): Explained => ({
  decided: true, error: null, project: { root: '/p', agdaLib: '/p/p.agda-lib' }, flake: '/p', decidedBy: 'discovered',
  method: 'package', name: 'default', program: '/nix/store/a-agda/bin/agda', args: [], env: {}, version: '2.9.0',
  built: 'yes', choice: null, ...fields,
});

test('the launcher is asked about the file, and its refusals and failures say why', async () => {
  const asked: string[][] = [];
  const run = (reply: Ran) => async (_launcher: string, args: string[]) => { asked.push(args); return reply; };
  const decided = await explain('agda-for-project', '/p/M.agda', run({ code: 0, stdout: JSON.stringify(answer({})), stderr: '' }));
  assert.equal(decided.version, '2.9.0');
  assert.deepEqual(asked.at(-1), ['--explain', '--json', '/p/M.agda']);
  await explain('agda-for-project', '/p/M.agda', run({ code: 0, stdout: JSON.stringify(answer({})), stderr: '' }), true);
  assert.deepEqual(asked.at(-1), ['--explain', '--json', '--no-build', '/p/M.agda']);
  // Exit 69: one JSON object still, and the one line on stderr.
  const refused = await explain('agda-for-project', '/p/M.agda', run({
    code: 69, stdout: JSON.stringify(answer({ decided: false, error: null, program: null })),
    stderr: 'building...\nagda-for-project: no flake.nix at or above /p\n',
  }));
  assert.equal(refused.decided, false);
  assert.equal(refused.error, 'agda-for-project: no flake.nix at or above /p');
  await assert.rejects(explain('agda-for-project', '/p/M.agda', run({ code: 64, stdout: '', stderr: 'agda-for-project: unknown option --json\n' })),
    /--explain did not answer \(exit 64\): agda-for-project: unknown option --json/);
  assert.equal(lastLine('a\n\n b \n'), 'b');
  const offered = await candidates('agda-for-project', '/p/M.agda', run({ code: 0, stdout: '[{"id":"devshell:default","kind":"devshell","version":null,"label":"x","chosen":false}]', stderr: '' }));
  assert.equal(offered[0]?.id, 'devshell:default');
  await choose('agda-for-project', '/p/M.agda', 'path:/a', run({ code: 0, stdout: '', stderr: '' }));
  assert.deepEqual(asked.at(-1), ['--choose', 'path:/a', '/p/M.agda']);
  await choose('agda-for-project', '/p/M.agda', null, run({ code: 0, stdout: '', stderr: '' }));
  assert.deepEqual(asked.at(-1), ['--forget', '/p/M.agda']);
  await assert.rejects(choose('agda-for-project', '/p/M.agda', 'bad', run({ code: 64, stdout: '', stderr: 'agda-for-project: not an ID\n' })), /not an ID/);
});

test('one Agda serves two projects only when it runs the same program, arguments and environment', () => {
  assert.equal(runKey(answer({ project: { root: '/a', agdaLib: null } })), runKey(answer({ project: { root: '/b', agdaLib: null } })));
  assert.notEqual(runKey(answer({})), runKey(answer({ args: ['--library-file=/r.libraries'] })));
  assert.notEqual(runKey(answer({})), runKey(answer({ env: { AGDA_DIR: '/p/.agda' } })));
  assert.equal(runKey(answer({ env: { A: '1', B: '2' } })), runKey(answer({ env: { B: '2', A: '1' } })));
});

test('the lanes speak 2.9.0 and 2.8.0, and refuse another, saying where it came from', () => {
  assert.equal(laneVersionRefusal('2.9.0', 'x'), null);
  assert.equal(laneVersionRefusal('2.8.0', 'x'), null);
  assert.equal(laneVersionRefusal('2.7.0.1', "the project's Agda (the flake's default)"),
    "the native lanes speak the protocol of Agda 2.9.0 and 2.8.0; the project's Agda (the flake's default) is Agda 2.7.0.1");
});

test('the mode runs the launcher only when the last of its paths names it', () => {
  assert.equal(modeLauncher(['agda', 'agda-for-project']), 'agda-for-project');
  assert.equal(modeLauncher(['/nix/profile/bin/agda-for-project ']), '/nix/profile/bin/agda-for-project');
  assert.equal(modeLauncher(['agda-for-project', 'agda']), undefined);
  assert.equal(modeLauncher(['agda-for-project-old']), undefined);
  assert.equal(modeLauncher('agda-for-project'), undefined);
  assert.equal(modeLauncher([]), undefined);
});

test("the mode's Agda is the host's descendant started with --interaction, not a lane's or its shell", () => {
  const processes = parsePs([
    '    1     0 /sbin/init',
    '  100     1 code --type=extensionHost',
    '  101   100 /bin/sh -c "/x/agda-for-project" --interaction',
    '  102   101 /nix/store/b-agda/bin/agda --interaction --library-file=/r.libraries',
    '  103   100 /nix/store/b-agda/bin/agda --interaction-json',
    '  200     1 /nix/store/c-agda/bin/agda --interaction',
  ].join('\n'));
  assert.equal(processes.length, 6);
  assert.deepEqual(modeAgda(processes, 100), { pid: 102, ppid: 101, args: '/nix/store/b-agda/bin/agda --interaction --library-file=/r.libraries' });
  assert.equal(modeAgda(processes.filter(each => each.pid !== 102), 100), undefined);
  assert.equal(modeAgda(processes, 999), undefined);
});

test('a starter flake holds the libraries nixpkgs has, and names the others', () => {
  assert.deepEqual(libraryDepends('name: x\ndepend: standard-library-2.3\n  cubical, my-lib -- mine\ninclude: src\n'),
    ['standard-library-2.3', 'cubical', 'my-lib']);
  assert.deepEqual(libraryDepends('name: x\ninclude: .\n'), []);
  const starter = starterFlake('x', ['standard-library-2.3', 'cubical', 'my-lib', 'IAL-1.3']);
  assert.deepEqual(starter.included, ['standard-library', 'cubical', 'iowa-stdlib']);
  assert.deepEqual(starter.missing, ['my-lib']);
  assert.match(starter.text, /default = pkgs\.agda\.withPackages \(p: \[ p\.standard-library p\.cubical p\.iowa-stdlib \]\);/);
  assert.match(starter.text, /inputs\.nixpkgs\.url = "github:NixOS\/nixpkgs\/nixos-25\.11";/);
  assert.match(starter.text, /Not in nixpkgs, so not included: my-lib\./);
  assert.match(starter.text, /legacyPackages\.\$\{system\}/);
});

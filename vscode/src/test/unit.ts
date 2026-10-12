// File: vscode/src/test/unit.ts

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeResult } from '../answers';
import { compatibility } from '../compatibility';
import { tokenReader } from '../highlighting';
import { agdaCandidates, isLanguageServer, splitOptions } from '../resolution';
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

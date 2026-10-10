// File: vscode/src/test/unit.ts

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compatibility } from '../compatibility';
import { tokenReader } from '../highlighting';
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

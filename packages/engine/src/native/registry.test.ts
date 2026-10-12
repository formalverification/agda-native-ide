// File: packages/engine/src/native/registry.test.ts
//
// The lane registry's rules, one test each, against a stand-in for `agda`:
// a node script that prints the prompt, answers `Cmd_show_version` and
// `Cmd_load` (refusing a file that says BROKEN), never answers
// `Cmd_infer_toplevel` nor `Cmd_abort`, runs as a batch check without
// `--interaction-json`, and exits at the end of its input, as Agda does.
// The conformance runner checks the same rules against the real Agda
// (scripts/conformance/native.mjs).

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionOptions } from "../core/index.js";
import { LaneRegistry, type LaneConfig, type LaneEnded } from "./registry.js";

let dir: string;
let agda: string;
let rootA: string;
let rootB: string;
let pids: string;

const STAND_IN = `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.env.FAKE_PIDS, String(process.pid)), "");
if (!process.argv.includes("--interaction-json")) {
  const file = process.argv[process.argv.length - 1];
  process.exitCode = fs.readFileSync(file, "utf8").includes("{!") ? 42 : 0;
  return;
}
const out = (json) => process.stdout.write(JSON.stringify(json) + "\\n");
const lines = require("node:readline").createInterface({ input: process.stdin });
setTimeout(() => process.stdout.write("JSON> "), Number(process.env.FAKE_START_DELAY ?? 0));
lines.on("line", (line) => {
  const load = /Cmd_load "([^"]*)"/.exec(line);
  if (line.includes("Cmd_show_version")) out({ kind: "DisplayInfo", info: { kind: "Version", version: "2.9.0" } });
  else if (load) {
    const text = fs.readFileSync(load[1], "utf8");
    out({ kind: "RunningInfo", debugLevel: 1, message: "Checking M (" + load[1] + ").\\n" });
    if (text.includes("BROKEN")) out({ kind: "DisplayInfo", info: { kind: "Error", error: { message: "broken" }, warnings: [] } });
    out({ kind: "InteractionPoints", interactionPoints: [] });
  } else if (line.includes("Cmd_infer_toplevel") || line.includes("Cmd_abort")) return;
  process.stdout.write("JSON> ");
});
lines.on("close", () => setTimeout(() => process.exit(0), Number(process.env.FAKE_EXIT_DELAY ?? 0)));
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-registry-"));
  agda = join(dir, "agda");
  writeFileSync(agda, `#!${process.execPath}\n${STAND_IN}`);
  chmodSync(agda, 0o755);
  rootA = join(dir, "a");
  rootB = join(dir, "b");
  pids = join(dir, "pids");
  for (const directory of [rootA, rootB, pids]) mkdirSync(directory);
  writeFileSync(join(rootA, "a.agda-lib"), "name: a\ninclude: .\n");
  writeFileSync(join(rootB, "b.agda-lib"), "name: b\ninclude: .\n");
  writeFileSync(join(rootA, "One.agda"), "module One where\n");
  writeFileSync(join(rootA, "Two.agda"), "module Two where\n");
  writeFileSync(join(rootB, "Three.agda"), "module Three where\nx = {! !}\n");
  writeFileSync(join(rootA, "Bad.agda"), "module Bad where\nBROKEN\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (condition: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
};

function registryWith(
  options: {
    idleMs?: number;
    env?: Record<string, string>;
    config?: (path: string) => Partial<LaneConfig>;
    session?: SessionOptions;
  } = {},
) {
  const ended: LaneEnded[] = [];
  const registry = new LaneRegistry({
    resolve: (path) => ({
      root: path.startsWith(rootA) ? rootA : rootB,
      executable: agda,
      args: [],
      env: { ...process.env, FAKE_PIDS: pids, ...options.env },
      ...options.config?.(path),
    }),
    killGraceMs: 200,
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    ...(options.session ? { session: options.session } : {}),
    onLaneEnded: (event) => ended.push(event),
  });
  return { registry, ended };
}

const look = (use: { load: string; pid: number | undefined; spawned: boolean }) => ({
  load: use.load,
  pid: use.pid,
  spawned: use.spawned,
});

describe("the lane registry", () => {
  it("keeps one lane per root, and loads a file only when Agda's text is not the file's", async () => {
    const { registry } = registryWith();
    const one = join(rootA, "One.agda");
    const first = (await registry.withFile(one, async (use) => look(use))) as ReturnType<typeof look>;
    expect(first).toMatchObject({ load: "first", spawned: true });
    expect(await registry.withFile(one, async (use) => look(use))).toEqual({ ...first, load: "reused", spawned: false });
    // The same size and another text: the stamp is the text.
    writeFileSync(one, "module One where\n".replace("One", "Eno"));
    expect(await registry.withFile(one, async (use) => use.load)).toBe("changed");
    writeFileSync(one, "module One where\n");
    const two = join(rootA, "Two.agda");
    expect(await registry.withFile(two, async (use) => look(use))).toEqual({ ...first, load: "switch", spawned: false });
    expect(await registry.withFile(two, async (use) => use.load, { reload: true })).toBe("requested");
    const bad = join(rootA, "Bad.agda");
    expect(await registry.withFile(bad, async (use) => use.loaded?.value.errors)).toEqual(["broken"]);
    expect(await registry.withFile(bad, async (use) => use.load)).toBe("retry");
    const three = (await registry.withFile(join(rootB, "Three.agda"), async (use) => look(use))) as ReturnType<typeof look>;
    expect(three).toMatchObject({ load: "first", spawned: true });
    expect(three.pid).not.toBe(first.pid);
    expect(registry.lanes().map((lane) => lane.root).sort()).toEqual([rootA, rootB]);
    await registry.dispose();
  });

  it("serializes one lane's requests, each holding the lane until its operations end", async () => {
    const { registry } = registryWith();
    const order: string[] = [];
    const request = (name: string, ms: number) =>
      registry.withFile(join(rootA, name === "first" ? "One.agda" : "Two.agda"), async () => {
        order.push(`${name} starts`);
        await new Promise((done) => setTimeout(done, ms));
        order.push(`${name} ends`);
      });
    await Promise.all([request("first", 60), request("second", 0)]);
    expect(order).toEqual(["first starts", "first ends", "second starts", "second ends"]);
    await registry.dispose();
  });

  it("surfaces a crash once, and starts a new lane on the next request", async () => {
    const { registry, ended } = registryWith();
    const one = join(rootA, "One.agda");
    const before = (await registry.withFile(one, async (use) => use.pid)) as number;
    process.kill(before, "SIGKILL");
    await until(() => ended.length === 1, 2_000);
    expect(ended).toMatchObject([{ root: rootA, pid: before, reason: "crashed", detail: { signal: "SIGKILL" } }]);
    const after = (await registry.withFile(one, async (use) => look(use))) as ReturnType<typeof look>;
    expect(after).toMatchObject({ load: "first", spawned: true });
    expect(after.pid).not.toBe(before);
    // A crash during a request fails the request, and is told once.
    const interrupted = await registry.withFile(one, async ({ session, pid }) => {
      const pending = session.infer("anything");
      setTimeout(() => process.kill(pid!, "SIGKILL"), 50);
      return pending;
    });
    expect(interrupted).toMatchObject({ kind: "failure", reason: "session-ended" });
    await until(() => ended.length === 2, 2_000);
    expect(ended.map((event) => event.reason)).toEqual(["crashed", "crashed"]);
    expect(await registry.withFile(one, async (use) => use.spawned)).toBe(true);
    await registry.dispose();
  });

  it("tells of a lane a deadline stopped once it is gone, with the session's account", async () => {
    const { registry, ended } = registryWith({ session: { deadlines: { infer: 100 }, abortGraceMs: 100 } });
    const one = join(rootA, "One.agda");
    const stuck = await registry.withFile(one, async ({ session }) => session.infer("anything"));
    expect(stuck).toMatchObject({ kind: "failure", reason: "timeout", detail: { terminated: true } });
    await until(() => ended.length > 0, 2_000);
    expect(ended).toMatchObject([{ reason: "crashed", detail: { reason: "timeout", operation: "infer" } }]);
    expect(await registry.withFile(one, async (use) => use.spawned)).toBe(true);
    await new Promise((done) => setTimeout(done, 100));
    expect(ended).toHaveLength(1);
    await registry.dispose();
  });

  it("closes an idle lane by closing its input, which Agda answers by exiting, code 0", async () => {
    const { registry, ended } = registryWith({ idleMs: 100 });
    const pid = (await registry.withFile(join(rootA, "One.agda"), async (use) => use.pid)) as number;
    await until(() => ended.length === 1, 2_000);
    expect(ended).toMatchObject([{ pid, reason: "idle", exit: { code: 0, signal: null } }]);
    expect(alive(pid)).toBe(false);
    expect(registry.lanes()).toEqual([]);
    expect(await registry.withFile(join(rootA, "One.agda"), async (use) => use.spawned)).toBe(true);
    await registry.dispose();
  });

  it("starts no lane for a root until its idle lane's Agda is gone", async () => {
    const { registry, ended } = registryWith({ idleMs: 100, env: { FAKE_EXIT_DELAY: "150" } });
    const one = join(rootA, "One.agda");
    const before = (await registry.withFile(one, async (use) => use.pid)) as number;
    // The idle close begins at 100 ms, and the old Agda exits 150 ms later.
    await new Promise((done) => setTimeout(done, 150));
    const overlap = await registry.withFile(one, async (use) => ({ spawned: use.spawned, oldAlive: alive(before) }));
    expect(overlap).toEqual({ spawned: true, oldAlive: false });
    expect(ended).toMatchObject([{ pid: before, reason: "idle", exit: { code: 0 } }]);
    await registry.dispose();
  });

  it("replaces a lane whose resolution changed", async () => {
    let args: string[] = [];
    const { registry, ended } = registryWith({ config: () => ({ args }) });
    const one = join(rootA, "One.agda");
    const before = (await registry.withFile(one, async (use) => use.pid)) as number;
    args = ["--flag"];
    const after = (await registry.withFile(one, async (use) => look(use))) as ReturnType<typeof look>;
    expect(after).toMatchObject({ load: "first", spawned: true });
    expect(ended).toMatchObject([{ pid: before, reason: "replaced" }]);
    expect(alive(before)).toBe(false);
    await registry.dispose();
  });

  it("gives a verdict through a root's lane, loading nothing", async () => {
    const { registry } = registryWith();
    const three = join(rootB, "Three.agda");
    const verdict = await registry.withLane(three, ({ session }) => session.checkFile(three));
    expect(verdict).toMatchObject({ kind: "verdict", exitCode: 42, command: { args: [three], cwd: rootB } });
    expect(await registry.withFile(three, async (use) => use.load)).toBe("first");
    await registry.dispose();
  });

  it("passes on a resolution's refusal, and starts nothing", async () => {
    const registry = new LaneRegistry({
      resolve: () => ({ kind: "refusal", reason: "configuration", message: "no Agda was found" }),
    });
    expect(await registry.withFile(join(rootA, "One.agda"), async () => "ran")).toEqual({
      kind: "refusal",
      reason: "configuration",
      message: "no Agda was found",
    });
    expect(registry.lanes()).toEqual([]);
  });

  it("closes every lane at disposal, a lane starting then included, and refuses from then on", async () => {
    for (const pid of readdirSync(pids)) rmSync(join(pids, pid));
    const { registry, ended } = registryWith();
    await registry.withFile(join(rootA, "One.agda"), async () => undefined);
    const { registry: slow } = registryWith({ env: { FAKE_START_DELAY: "300" } });
    const starting = slow.withFile(join(rootB, "Three.agda"), async () => "ran");
    await new Promise((done) => setTimeout(done, 100));
    await Promise.all([registry.dispose(), slow.dispose()]);
    expect(await starting).toMatchObject({ kind: "refusal", reason: "session-ended" });
    expect(ended).toMatchObject([{ reason: "disposed" }]);
    const started = readdirSync(pids).map(Number);
    expect(started).toHaveLength(2);
    expect(started.filter(alive)).toEqual([]);
    expect(await registry.withFile(join(rootA, "One.agda"), async () => "ran")).toMatchObject({
      kind: "refusal",
      reason: "session-ended",
    });
  });
});
